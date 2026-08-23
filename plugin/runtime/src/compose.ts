import {
	type ComposeContextRequest,
	type ContextMutation,
	type ContextPlan,
	validateContextPlan,
} from "@cortexkit/magic-context-core-plugin";
import type {
	CanonicalBlock,
	CanonicalMessage,
} from "@cortexkit/magic-context-core-plugin/protocol";

import { type RuntimePolicyConfig, resolveRuntimeSchedule } from "./scheduler";
import type { RuntimeSessionState } from "./state-store";

export {
	DEFAULT_RUNTIME_POLICY,
	deriveMemoryBudgetTokens,
	normalizeRuntimePolicy,
	type RuntimePolicyConfig,
} from "./scheduler";

const REDUCTION_MARKER = "\n...[reduced by Magic Context runtime]...\n";

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
	stablePartIds: boolean,
): { mutation: ContextMutation; estimatedTokens: number } | undefined {
	const originalTokens = estimateCanonicalMessageTokens(message);
	// A message-level replacement does not remove a native assistant tool call;
	// claiming those input tokens were reclaimed would make accounting unsafe.
	if (message.content.some((block) => block.kind === "tool_call")) {
		return undefined;
	}
	if (stablePartIds) {
		const candidates = message.content
			.map((block, index) => ({ block, index, text: blockText(block) }))
			.filter(
				(item) =>
					item.block.id &&
					item.block.kind !== "tool_call" &&
					item.text.length > 0,
			)
			.sort((left, right) => right.text.length - left.text.length);
		for (const candidate of candidates) {
			let low = 0;
			let high = candidate.text.length;
			let best: { content: string; estimatedTokens: number } | undefined;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const content = boundedText(candidate.text, middle);
				const replacement = {
					...message,
					content: message.content.map((block, index) =>
						index === candidate.index
							? { kind: "text" as const, text: content }
							: block,
					),
				};
				const estimatedTokens = estimateCanonicalMessageTokens(replacement);
				if (estimatedTokens <= allowedTokens) {
					best = { content, estimatedTokens };
					low = middle + 1;
				} else {
					high = middle - 1;
				}
			}
			if (best && best.estimatedTokens < originalTokens) {
				return {
					mutation: {
						target: {
							messageId: message.id,
							blockId: candidate.block.id,
						},
						operation:
							candidate.block.kind === "tool_result"
								? "truncate_tool"
								: "replace",
						content: best.content,
					},
					estimatedTokens: best.estimatedTokens,
				};
			}
		}
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
	stablePartIds: boolean,
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
		const fitted = fitMutation(message, allowedTokens, stablePartIds);
		if (!fitted) continue;
		mutations.push(fitted.mutation);
		estimates.set(message.id, fitted.estimatedTokens);
		total += fitted.estimatedTokens - currentTokens;
	}
	return { mutations, estimatedTokens: Math.max(0, total) };
}

export interface ComposeContextOutcome {
	plan: ContextPlan;
	drainLatchActiveSinceMs?: number;
	deferredExecute?: { reason: string };
	activeMemoryFingerprint?: string;
	activeMemoryEpoch?: number;
	activeTagFingerprint?: string;
}

export interface RuntimeMemoryInjection {
	content: string;
	epoch: number;
	fingerprint: string;
	estimatedTokens: number;
	memoryIds?: number[];
	/** Portion already charged against the history partition. */
	historyEstimatedTokens?: number;
}

export interface RuntimeTriggerInjection {
	content: string;
	epoch: number;
	fingerprint: string;
	estimatedTokens: number;
	triggerIds: string[];
}

export interface RuntimeTaggingPlan {
	mutations: ContextMutation[];
	fingerprint: string;
	estimatedTokens: number;
}

export function composeContext(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
	config: RuntimePolicyConfig,
	nowMs: number,
	memoryInjection?: RuntimeMemoryInjection,
	triggerInjection?: RuntimeTriggerInjection,
	tagging?: RuntimeTaggingPlan,
): ComposeContextOutcome {
	const explicitlyDropped = new Set(state.droppedMessageOrdinals);
	const effectiveMessages = request.messages.filter(
		(message) => !explicitlyDropped.has(message.ordinal),
	);
	const explicitDropMessages = request.messages.filter((message) =>
		explicitlyDropped.has(message.ordinal),
	);
	const forwardTokens = estimateCanonicalTokens(effectiveMessages);
	const injectionTokens =
		(memoryInjection?.estimatedTokens ?? 0) +
		(triggerInjection?.estimatedTokens ?? 0) +
		(tagging?.estimatedTokens ?? 0);
	const schedule = resolveRuntimeSchedule({
		request,
		state,
		config,
		nowMs,
		forwardTokens,
		memoryActive: Boolean(memoryInjection),
		historyEstimatedTokens: memoryInjection?.historyEstimatedTokens ?? 0,
		injectionTokens,
		unpartitionedInjectionTokens:
			(triggerInjection?.estimatedTokens ?? 0) +
			(tagging?.estimatedTokens ?? 0),
		midToolUse: hasOpenToolArc(effectiveMessages),
	});
	if (schedule.contextLimitTokens === 0) {
		const plan: ContextPlan = {
			protocolVersion: 1,
			requestId: request.requestId,
			decision: "defer",
			retain: { messageIds: request.messages.map((message) => message.id) },
			mutations: [
				...explicitDropMessages.map((message) => ({
					target: { messageId: message.id },
					operation: "drop" as const,
				})),
				...(tagging?.mutations ?? []),
			],
			injections: triggerInjection
				? [
						{
							slot: "tail_nudge" as const,
							content: triggerInjection.content,
							epoch: triggerInjection.epoch,
							fingerprint: triggerInjection.fingerprint,
						},
					]
				: [],
			accounting: {
				estimatedInputTokens:
					forwardTokens +
					(triggerInjection?.estimatedTokens ?? 0) +
					(tagging?.estimatedTokens ?? 0),
				hardLimitTokens: 0,
				cacheDecision:
					explicitDropMessages.length > 0 ||
					triggerInjection ||
					((tagging?.mutations.length ?? 0) > 0 &&
						tagging?.fingerprint !== state.activeTagFingerprint)
						? "bust_required"
						: "hit_safe",
			},
			reason: "unknown-context-limit",
		};
		validateContextPlan(request, plan);
		return { plan, activeTagFingerprint: tagging?.fingerprint };
	}
	const hardLimitTokens = schedule.hardLimitTokens;
	const scheduleDecision = schedule.decision;
	if (!scheduleDecision) throw new Error("scheduler returned no decision");
	const targetTokens = schedule.targetTokens;
	const selected =
		forwardTokens <= targetTokens
			? [...effectiveMessages]
			: selectProtectedTail(effectiveMessages, targetTokens);
	const trimmed = trimSelectedMessages(
		selected,
		targetTokens,
		request.capabilities.stablePartIds,
	);
	const transcriptChanged =
		effectiveMessages.length !== request.messages.length ||
		selected.length !== effectiveMessages.length ||
		trimmed.mutations.length > 0;
	const memoryChanged =
		memoryInjection?.fingerprint !== state.activeMemoryFingerprint;
	const taggingChanged =
		(tagging?.mutations.length ?? 0) > 0 &&
		tagging?.fingerprint !== state.activeTagFingerprint;
	const changed =
		transcriptChanged ||
		memoryChanged ||
		taggingChanged ||
		Boolean(triggerInjection);
	const decision = !changed
		? scheduleDecision.pass === "defer"
			? "defer"
			: "serve"
		: trimmed.estimatedTokens > targetTokens ||
				scheduleDecision.pass === "emergency"
			? "safe_fallback"
			: "serve";
	const firstTail = selected.find((message) => message.role !== "system");
	const injections = [
		...(memoryInjection
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
			: []),
		...(triggerInjection
			? [
					{
						slot: "tail_nudge" as const,
						content: triggerInjection.content,
						epoch: triggerInjection.epoch,
						fingerprint: triggerInjection.fingerprint,
					},
				]
			: []),
	];
	const retained = new Set([
		...selected.map((message) => message.id),
		...explicitDropMessages.map((message) => message.id),
	]);
	const plan: ContextPlan = {
		protocolVersion: 1,
		requestId: request.requestId,
		decision,
		retain: {
			messageIds: request.messages
				.filter((message) => retained.has(message.id))
				.map((message) => message.id),
			protectedTailStart: firstTail?.id,
		},
		mutations: [
			...explicitDropMessages.map((message) => ({
				target: { messageId: message.id },
				operation: "drop" as const,
			})),
			...trimmed.mutations,
			...(tagging?.mutations ?? []),
		],
		injections,
		accounting: {
			estimatedInputTokens: trimmed.estimatedTokens + injectionTokens,
			hardLimitTokens,
			cacheDecision: changed ? "bust_required" : "hit_safe",
		},
		reason: `schedule:${scheduleDecision.pass};pressure:${scheduleDecision.pressureBand};target:${targetTokens}`,
	};
	validateContextPlan(request, plan);
	return {
		plan,
		drainLatchActiveSinceMs: scheduleDecision.drainLatchActiveSinceMs,
		deferredExecute: scheduleDecision.deferredExecute,
		activeMemoryFingerprint: memoryInjection?.fingerprint,
		activeMemoryEpoch: memoryInjection?.epoch,
		activeTagFingerprint: tagging?.fingerprint,
	};
}
