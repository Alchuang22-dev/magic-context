export const CORE_PROTOCOL_VERSION = 1 as const;

export type ContextDecision = "serve" | "defer" | "safe_fallback" | "block";
export type ContextInjectionSlot =
	| "stable_prefix"
	| "volatile_delta"
	| "tail_nudge";
export type ContextMutationKind =
	| "drop"
	| "replace"
	| "truncate_tool"
	| "edit_marker";

export interface AgentCapabilities {
	preRequestTransform: boolean;
	stableMessageIds: boolean;
	stablePartIds: boolean;
	usageObservation: boolean;
	auxiliaryLlm: boolean;
	toolRegistration: boolean;
	toolEvents: boolean;
	requestBlocking: boolean;
	systemSuffixInjection: boolean;
	promptCacheFacts: boolean;
}

export const CONSERVATIVE_CAPABILITIES: Readonly<AgentCapabilities> =
	Object.freeze({
		preRequestTransform: true,
		stableMessageIds: false,
		stablePartIds: false,
		usageObservation: false,
		auxiliaryLlm: false,
		toolRegistration: false,
		toolEvents: false,
		requestBlocking: false,
		systemSuffixInjection: false,
		promptCacheFacts: false,
	});

export function resolveCapabilities(
	advertised: Partial<AgentCapabilities> = {},
): AgentCapabilities {
	return { ...CONSERVATIVE_CAPABILITIES, ...advertised };
}

export type CanonicalRole = "system" | "user" | "assistant" | "tool" | string;

export interface CanonicalTextBlock {
	id?: string;
	kind: "text" | "thinking";
	text: string;
}

export interface CanonicalToolCallBlock {
	id?: string;
	kind: "tool_call";
	callId: string;
	name: string;
	input: unknown;
}

export interface CanonicalToolResultBlock {
	id?: string;
	kind: "tool_result";
	callId: string;
	name?: string;
	output: unknown;
	isError?: boolean;
}

export interface CanonicalOpaqueBlock {
	id?: string;
	kind: "image" | "file" | "opaque";
	value: unknown;
}

export type CanonicalBlock =
	| CanonicalTextBlock
	| CanonicalToolCallBlock
	| CanonicalToolResultBlock
	| CanonicalOpaqueBlock;

export interface CanonicalMessage {
	id: string;
	ordinal: number;
	role: CanonicalRole;
	content: CanonicalBlock[];
	createdAtMs?: number;
	synthetic?: boolean;
}

export interface ContextUsageObservation {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	contextLimitTokens?: number;
}

export interface ComposeContextRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	requestId: string;
	host: string;
	sessionId: string;
	turnId?: string;
	projectId?: string;
	modelKey?: string;
	budgetTokens: number;
	capabilities: AgentCapabilities;
	messages: CanonicalMessage[];
	usage?: ContextUsageObservation;
}

export interface ContextMutation {
	target: { messageId: string; blockId?: string };
	operation: ContextMutationKind;
	content?: string;
}

export interface ContextInjection {
	slot: ContextInjectionSlot;
	content: unknown;
	epoch: number;
	fingerprint: string;
}

export interface ContextPlan {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	requestId: string;
	decision: ContextDecision;
	retain: {
		messageIds: string[];
		protectedTailStart?: string;
	};
	mutations: ContextMutation[];
	injections: ContextInjection[];
	accounting: {
		estimatedInputTokens: number;
		hardLimitTokens: number;
		cacheDecision: "hit_safe" | "bust_required";
	};
	reason?: string;
}

export interface AgentContextAdapter<NativeMessages = unknown> {
	readonly host: string;
	readonly capabilities: AgentCapabilities;
	snapshot(messages: NativeMessages): CanonicalMessage[];
	materialize(messages: NativeMessages, plan: ContextPlan): NativeMessages;
}

export class InvalidContextPlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidContextPlanError";
	}
}

/** Validate only cross-host invariants; native role/tool legality stays adapter-owned. */
export function validateContextPlan(
	request: ComposeContextRequest,
	plan: ContextPlan,
): ContextPlan {
	if (plan.protocolVersion !== CORE_PROTOCOL_VERSION) {
		throw new InvalidContextPlanError(
			`unsupported protocol version ${String(plan.protocolVersion)}`,
		);
	}
	if (plan.requestId !== request.requestId) {
		throw new InvalidContextPlanError(
			"requestId does not match compose request",
		);
	}
	if (!Number.isFinite(plan.accounting.estimatedInputTokens)) {
		throw new InvalidContextPlanError("estimatedInputTokens must be finite");
	}
	if (plan.accounting.estimatedInputTokens < 0) {
		throw new InvalidContextPlanError(
			"estimatedInputTokens must not be negative",
		);
	}
	const knownMessages = new Set(request.messages.map((message) => message.id));
	const retained = new Set<string>();
	for (const messageId of plan.retain.messageIds) {
		if (!knownMessages.has(messageId)) {
			throw new InvalidContextPlanError(
				`retain references unknown message ${messageId}`,
			);
		}
		if (retained.has(messageId)) {
			throw new InvalidContextPlanError(
				`retain contains duplicate message ${messageId}`,
			);
		}
		retained.add(messageId);
	}
	for (const mutation of plan.mutations) {
		if (!knownMessages.has(mutation.target.messageId)) {
			throw new InvalidContextPlanError(
				`mutation references unknown message ${mutation.target.messageId}`,
			);
		}
		if (mutation.operation === "replace" && mutation.content === undefined) {
			throw new InvalidContextPlanError("replace mutation requires content");
		}
	}
	const injectionKeys = new Set<string>();
	for (const injection of plan.injections) {
		if (!Number.isInteger(injection.epoch) || injection.epoch < 0) {
			throw new InvalidContextPlanError(
				"injection epoch must be a non-negative integer",
			);
		}
		const key = `${injection.slot}:${injection.epoch}`;
		if (injectionKeys.has(key)) {
			throw new InvalidContextPlanError(`duplicate injection identity ${key}`);
		}
		injectionKeys.add(key);
	}
	if (plan.decision === "block" && !request.capabilities.requestBlocking) {
		throw new InvalidContextPlanError(
			"host cannot materialize a blocking decision",
		);
	}
	return plan;
}
