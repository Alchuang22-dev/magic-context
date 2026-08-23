import {
	applyTokenPressureFloor,
	type ComposeContextRequest,
	type ContextMutation,
	type ContextPlan,
	computeTokenPressure,
	decideContextSchedule,
	partitionContextBudget,
	validateContextPlan,
} from "@cortexkit/magic-context-core-plugin";
import type {
	CanonicalBlock,
	CanonicalMessage,
	ContextUsageObservation,
} from "@cortexkit/magic-context-core-plugin/protocol";

import type { RuntimeSessionState } from "./state-store";

const REDUCTION_MARKER = "\n...[reduced by Magic Context runtime]...\n";

export interface RuntimePolicyConfig {
	executeThresholdPercentage: number;
	historyBudgetPercentage: number;
	memoryBudgetTokens: number;
	memoryBudgetPercentage: number;
	cacheTtl: string;
	maxObservedTurns: number;
}

export const DEFAULT_RUNTIME_POLICY: Readonly<RuntimePolicyConfig> =
	Object.freeze({
		executeThresholdPercentage: 65,
		historyBudgetPercentage: 0.15,
		memoryBudgetTokens: 8_000,
		memoryBudgetPercentage: 0.1,
		cacheTtl: "5m",
		maxObservedTurns: 32,
	});

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
		.join(",")}}`;
}

function bytesToTokens(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / 3));
}

function blockText(block: CanonicalBlock): string {
	switch (block.kind) {
		case "text":
		case "thinking":
			return block.text;
		case "tool_call":
			return `${block.name}\n${stableJson(block.input)}`;
		case "tool_result":
			return `${block.name ?? "tool"}\n${stableJson(block.output)}`;
		default:
			return stableJson(block.value);
	}
}

export function estimateCanonicalMessageTokens(
	message: CanonicalMessage,
): number {
	let tokens = 6 + bytesToTokens(Buffer.byteLength(message.role, "utf8"));
	for (const block of message.content) {
		tokens += 3 + bytesToTokens(Buffer.byteLength(blockText(block), "utf8"));
	}
	return tokens;
}

export function estimateCanonicalTokens(
	messages: readonly CanonicalMessage[],
): number {
	return messages.reduce(
		(total, message) => total + estimateCanonicalMessageTokens(message),
		0,
	);
}

function hasOpenToolArc(messages: readonly CanonicalMessage[]): boolean {
	const open = new Set<string>();
	for (const message of messages) {
		for (const block of message.content) {
			if (block.kind === "tool_call" && block.callId) open.add(block.callId);
			if (block.kind === "tool_result" && block.callId)
				open.delete(block.callId);
		}
	}
	return open.size > 0;
}

function turnSegments(
	messages: readonly CanonicalMessage[],
): CanonicalMessage[][] {
	const segments: CanonicalMessage[][] = [];
	let current: CanonicalMessage[] = [];
	for (const message of messages) {
		if (message.role === "user" && current.length > 0) {
			segments.push(current);
			current = [];
		}
		current.push(message);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

function selectProtectedTail(
	messages: readonly CanonicalMessage[],
	targetTokens: number,
): CanonicalMessage[] {
	const system = messages.filter((message) => message.role === "system");
	const body = messages.filter((message) => message.role !== "system");
	const segments = turnSegments(body);
	const selectedSegments: CanonicalMessage[][] = [];
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const candidateSegments = [segments[index], ...selectedSegments];
		const candidate = [...system, ...candidateSegments.flat()];
		if (
			selectedSegments.length > 0 &&
			estimateCanonicalTokens(candidate) > targetTokens
		) {
			break;
		}
		selectedSegments.unshift(segments[index]);
	}
	const ids = new Set(
		[...system, ...selectedSegments.flat()].map((message) => message.id),
	);
	const toolArcs = new Map<string, Set<string>>();
	for (const message of messages) {
		for (const block of message.content) {
			if (
				(block.kind !== "tool_call" && block.kind !== "tool_result") ||
				!block.callId
			) {
				continue;
			}
			const members = toolArcs.get(block.callId) ?? new Set<string>();
			members.add(message.id);
			toolArcs.set(block.callId, members);
		}
	}
	for (const members of toolArcs.values()) {
		if ([...members].some((messageId) => ids.has(messageId))) {
			for (const messageId of members) ids.add(messageId);
		}
	}
	return messages.filter((message) => ids.has(message.id));
}

function replacementMessage(
	message: CanonicalMessage,
	content: string,
): CanonicalMessage {
	return {
		...message,
		content: [{ kind: "text", text: content }],
	};
}

function messageSourceText(message: CanonicalMessage): string {
	return message.content.map(blockText).filter(Boolean).join("\n");
}

function boundedText(source: string, maxCharacters: number): string {
	if (maxCharacters <= REDUCTION_MARKER.length) return REDUCTION_MARKER.trim();
	if (source.length <= maxCharacters) return source;
	const payloadBudget = maxCharacters - REDUCTION_MARKER.length;
	const head = Math.ceil(payloadBudget * 0.67);
	const tail = payloadBudget - head;
	return `${source.slice(0, head)}${REDUCTION_MARKER}${
		tail > 0 ? source.slice(-tail) : ""
	}`;
}

function fitMutation(
	message: CanonicalMessage,
	allowedTokens: number,
): { mutation: ContextMutation; estimatedTokens: number } | undefined {
	const originalTokens = estimateCanonicalMessageTokens(message);
	// A message-level replacement does not remove a native assistant tool call;
	// claiming those input tokens were reclaimed would make accounting unsafe.
	if (message.content.some((block) => block.kind === "tool_call")) {
		return undefined;
	}
	const source = messageSourceText(message);
	if (source.length === 0) return undefined;
	let low = 0;
	let high = source.length;
	let best = REDUCTION_MARKER.trim();
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = boundedText(source, middle);
		const estimate = estimateCanonicalMessageTokens(
			replacementMessage(message, candidate),
		);
		if (estimate <= allowedTokens) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	const estimatedTokens = estimateCanonicalMessageTokens(
		replacementMessage(message, best),
	);
	if (estimatedTokens >= originalTokens) return undefined;
	const toolPayload =
		message.role === "tool" ||
		message.content.some((block) => block.kind === "tool_result");
	return {
		mutation: {
			target: { messageId: message.id },
			operation: toolPayload ? "truncate_tool" : "replace",
			content: best,
		},
		estimatedTokens,
	};
}

function trimSelectedMessages(
	selected: readonly CanonicalMessage[],
	targetTokens: number,
): { mutations: ContextMutation[]; estimatedTokens: number } {
	const estimates = new Map(
		selected.map((message) => [
			message.id,
			estimateCanonicalMessageTokens(message),
		]),
	);
	let total = [...estimates.values()].reduce((sum, value) => sum + value, 0);
	if (total <= targetTokens) return { mutations: [], estimatedTokens: total };

	const latestUserId = [...selected]
		.reverse()
		.find((message) => message.role === "user")?.id;
	const rank = (message: CanonicalMessage): number => {
		if (
			message.role === "tool" ||
			message.content.some((block) => block.kind === "tool_result")
		) {
			return 0;
		}
		if (message.role !== "system" && message.id !== latestUserId) return 1;
		if (message.role === "system") return 2;
		return 3;
	};
	const candidates = [...selected].sort((left, right) => {
		const rankDelta = rank(left) - rank(right);
		return rankDelta || left.ordinal - right.ordinal;
	});
	const mutations: ContextMutation[] = [];
	for (const message of candidates) {
		if (total <= targetTokens) break;
		const currentTokens = estimates.get(message.id) ?? 0;
		const allowedTokens = Math.max(1, targetTokens - (total - currentTokens));
		const fitted = fitMutation(message, allowedTokens);
		if (!fitted) continue;
		mutations.push(fitted.mutation);
		estimates.set(message.id, fitted.estimatedTokens);
		total += fitted.estimatedTokens - currentTokens;
	}
	return { mutations, estimatedTokens: Math.max(0, total) };
}

function observedUsage(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
): ContextUsageObservation {
	return request.usage ?? state.latestUsage ?? {};
}

export interface ComposeContextOutcome {
	plan: ContextPlan;
	drainLatchActiveSinceMs?: number;
	deferredExecute?: { reason: string };
	activeMemoryFingerprint?: string;
	activeMemoryEpoch?: number;
}

export interface RuntimeMemoryInjection {
	content: string;
	epoch: number;
	fingerprint: string;
	estimatedTokens: number;
}

function configuredContextLimit(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
): number {
	const observed = observedUsage(request, state);
	return Math.floor(
		finiteNonNegative(request.budgetTokens) ||
			finiteNonNegative(observed.contextLimitTokens),
	);
}

/** Maximum memory allocation for a compose call before recall is rendered. */
export function deriveMemoryBudgetTokens(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
	config: RuntimePolicyConfig,
): number {
	const contextLimitTokens = configuredContextLimit(request, state);
	if (contextLimitTokens === 0) return 0;
	const percentageCap = Math.floor(
		contextLimitTokens *
			Math.max(0, Math.min(1, config.memoryBudgetPercentage)),
	);
	return partitionContextBudget({
		contextLimitTokens,
		executeThresholdPercentage: config.executeThresholdPercentage,
		historyBudgetPercentage: config.historyBudgetPercentage,
		memoryBudgetTokens: Math.min(config.memoryBudgetTokens, percentageCap),
	}).memoryTokens;
}

export function composeContext(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
	config: RuntimePolicyConfig,
	nowMs: number,
	memoryInjection?: RuntimeMemoryInjection,
): ComposeContextOutcome {
	const forwardTokens = estimateCanonicalTokens(request.messages);
	const observed = observedUsage(request, state);
	const configuredLimit = configuredContextLimit(request, state);
	if (configuredLimit === 0) {
		const plan: ContextPlan = {
			protocolVersion: 1,
			requestId: request.requestId,
			decision: "defer",
			retain: { messageIds: request.messages.map((message) => message.id) },
			mutations: [],
			injections: [],
			accounting: {
				estimatedInputTokens: forwardTokens,
				hardLimitTokens: 0,
				cacheDecision: "hit_safe",
			},
			reason: "unknown-context-limit",
		};
		validateContextPlan(request, plan);
		return { plan };
	}
	const hardLimitTokens = Math.floor(
		configuredLimit || Math.max(1, forwardTokens),
	);
	const observedPressure = computeTokenPressure(observed, {
		softLimitTokens: hardLimitTokens,
		hardLimitTokens,
	});
	const floored = applyTokenPressureFloor(
		observedPressure,
		forwardTokens,
		hardLimitTokens,
	);
	const inputTokens = Math.max(
		observedPressure.inputTokens,
		floored.inputTokens,
	);
	const pressure = {
		inputTokens,
		percentage: Math.max(observedPressure.percentage, floored.percentage),
		hardWallPercentage: Math.max(
			observedPressure.hardWallPercentage,
			(inputTokens / hardLimitTokens) * 100,
		),
	};
	const schedule = decideContextSchedule({
		config: {
			executeThresholdPercentage: config.executeThresholdPercentage,
		},
		pressure,
		session: {
			lastResponseTimeMs: state.lastResponseTimeMs || nowMs,
			cacheTtl: config.cacheTtl,
		},
		nowMs,
		modelKey: request.modelKey,
		contextLimitTokens: hardLimitTokens,
		midToolUse: hasOpenToolArc(request.messages),
		deferredExecute: state.deferredExecute,
		drainLatchActiveSinceMs: state.drainLatchActiveSinceMs,
	});
	const partition = partitionContextBudget({
		contextLimitTokens: hardLimitTokens,
		executeThresholdPercentage: schedule.threshold.percentage,
		historyBudgetPercentage: config.historyBudgetPercentage,
		memoryBudgetTokens: memoryInjection
			? Math.min(
					config.memoryBudgetTokens,
					Math.floor(
						hardLimitTokens *
							Math.max(0, Math.min(1, config.memoryBudgetPercentage)),
					),
				)
			: 0,
	});
	const scheduledTarget = Math.max(
		1,
		partition.workingTokens + partition.historyTokens,
	);
	const injectionTokens = memoryInjection?.estimatedTokens ?? 0;
	const deferredTarget = Math.max(
		1,
		Math.floor(hardLimitTokens * 0.9) - injectionTokens,
	);
	const targetTokens =
		schedule.pass === "defer" ? deferredTarget : scheduledTarget;
	const selected =
		forwardTokens <= targetTokens
			? [...request.messages]
			: selectProtectedTail(request.messages, targetTokens);
	const trimmed = trimSelectedMessages(selected, targetTokens);
	const transcriptChanged =
		selected.length !== request.messages.length || trimmed.mutations.length > 0;
	const memoryChanged =
		memoryInjection?.fingerprint !== state.activeMemoryFingerprint;
	const changed = transcriptChanged || memoryChanged;
	const decision = !changed
		? schedule.pass === "defer"
			? "defer"
			: "serve"
		: trimmed.estimatedTokens > targetTokens || schedule.pass === "emergency"
			? "safe_fallback"
			: "serve";
	const firstTail = selected.find((message) => message.role !== "system");
	const injections = memoryInjection
		? [
				{
					slot: request.capabilities.systemSuffixInjection
						? ("stable_prefix" as const)
						: ("volatile_delta" as const),
					content: memoryInjection.content,
					epoch: memoryInjection.epoch,
					fingerprint: memoryInjection.fingerprint,
				},
			]
		: [];
	const plan: ContextPlan = {
		protocolVersion: 1,
		requestId: request.requestId,
		decision,
		retain: {
			messageIds: selected.map((message) => message.id),
			protectedTailStart: firstTail?.id,
		},
		mutations: trimmed.mutations,
		injections,
		accounting: {
			estimatedInputTokens: trimmed.estimatedTokens + injectionTokens,
			hardLimitTokens,
			cacheDecision: changed ? "bust_required" : "hit_safe",
		},
		reason: `schedule:${schedule.pass};pressure:${schedule.pressureBand};target:${targetTokens}`,
	};
	validateContextPlan(request, plan);
	return {
		plan,
		drainLatchActiveSinceMs: schedule.drainLatchActiveSinceMs,
		deferredExecute: schedule.deferredExecute,
		activeMemoryFingerprint: memoryInjection?.fingerprint,
		activeMemoryEpoch: memoryInjection?.epoch,
	};
}
