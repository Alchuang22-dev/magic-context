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
	| "edit_marker"
	| "prefix_tag";

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
	/** Apply a mutation to a block by its request-local canonical index. */
	blockIndexMutations?: boolean;
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
		blockIndexMutations: false,
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

export interface TurnOutcomeObservation {
	interrupted: boolean;
	failed: boolean;
	exitReason?: string;
}

/** The durable taxonomy accepted by the host-neutral Memory Module. */
export const MEMORY_CATEGORIES = [
	"PROJECT_RULES",
	"ARCHITECTURE",
	"CONSTRAINTS",
	"CONFIG_VALUES",
	"NAMING",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryScope = "project" | "ecosystem" | "universe";
export type MemorySourceType = "historian" | "agent" | "dreamer" | "tool";

/**
 * A host-neutral fact candidate. Extraction may be performed by a host's
 * historian model, but validation, deduplication, storage, and recall remain
 * runtime-owned.
 */
export interface ObservedMemoryCandidate {
	category: MemoryCategory;
	content: string;
	importance?: number;
	scope?: MemoryScope;
	shareable?: boolean;
	sourceType?: MemorySourceType;
	expiresAtMs?: number;
	metadata?: Record<string, unknown>;
}

/** Host-neutral, idempotent record of one completed agent turn. */
export interface ObserveTurnRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	observationId: string;
	host: string;
	sessionId: string;
	turnId?: string;
	taskId?: string;
	projectId?: string;
	modelKey?: string;
	observedAtMs: number;
	messages: CanonicalMessage[];
	usage?: ContextUsageObservation;
	outcome: TurnOutcomeObservation;
	memoryCandidates?: ObservedMemoryCandidate[];
}

export interface TurnObservationReceipt {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	observationId: string;
	sessionId: string;
	accepted: boolean;
	revision: number;
	observedAtMs: number;
	callbacks?: HostCallbackRequest[];
}

export const AUXILIARY_TASK_NAMES = [
	"historian",
	"dreamer",
	"sidekick",
] as const;

export type AuxiliaryTaskName = (typeof AUXILIARY_TASK_NAMES)[number];

export interface AuxiliaryRuntimePolicy {
	historianEnabled: boolean;
	historianThresholdPercentage: number;
	historianMinMessages: number;
	historianProtectedTailMessages: number;
	historianTimeoutMs: number;
	dreamerEnabled: boolean;
	dreamerIntervalMs: number;
	dreamerTimeoutMs: number;
	sidekickEnabled: boolean;
	sidekickTimeoutMs: number;
	maxAttempts: number;
}

export interface AuxiliaryLlmCompleteRequest {
	mode: "complete";
	messages: Array<{ role: string; content: string }>;
	temperature?: number;
	maxTokens?: number;
}

export interface AuxiliaryLlmStructuredRequest {
	mode: "structured";
	instructions: string;
	input: Array<{ type: "text"; text: string }>;
	jsonSchema: Record<string, unknown>;
	schemaName: string;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
}

export type AuxiliaryLlmRequest =
	| AuxiliaryLlmCompleteRequest
	| AuxiliaryLlmStructuredRequest;

/** Runtime-originated request that a host Adapter must execute at its LLM seam. */
export interface HostCallbackRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	callbackId: string;
	kind: "auxiliary_llm";
	host: string;
	sessionId: string;
	task: AuxiliaryTaskName;
	taskKey: string;
	purpose: string;
	createdAtMs: number;
	deadlineAtMs: number;
	attempt: number;
	request: AuxiliaryLlmRequest;
}

export interface HostCallbackSuccess {
	status: "completed";
	text: string;
	parsed?: unknown;
	provider?: string;
	model?: string;
	usage?: ContextUsageObservation;
}

export interface HostCallbackFailure {
	status: "failed" | "timed_out";
	errorType: string;
	message?: string;
}

export interface ResolveHostCallbackRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	resolutionId: string;
	host: string;
	sessionId: string;
	callbackId: string;
	attempt: number;
	resolvedAtMs: number;
	outcome: HostCallbackSuccess | HostCallbackFailure;
}

export type HostCallbackResolutionStatus =
	| "completed"
	| "retry_scheduled"
	| "failed";

export interface HostCallbackResolutionReceipt {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	resolutionId: string;
	callbackId: string;
	sessionId: string;
	accepted: boolean;
	status: HostCallbackResolutionStatus;
	revision: number;
	callbacks?: HostCallbackRequest[];
}

export interface MaintenancePollRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	pollId: string;
	host: string;
	sessionId: string;
	polledAtMs: number;
	tasks?: AuxiliaryTaskName[];
}

export interface MaintenancePollReceipt {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	pollId: string;
	sessionId: string;
	revision: number;
	callbacks: HostCallbackRequest[];
}

export const CONTEXT_TOOL_NAMES = [
	"ctx_search",
	"ctx_memory",
	"ctx_expand",
	"ctx_reduce",
	"ctx_note",
] as const;

export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

export interface ExecuteContextToolRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	requestId: string;
	host: string;
	sessionId: string;
	projectId?: string;
	modelKey?: string;
	toolName: ContextToolName;
	arguments: Record<string, unknown>;
	messages?: CanonicalMessage[];
	invokedAtMs: number;
}

export interface ContextToolExecutionResult {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	requestId: string;
	sessionId: string;
	toolName: ContextToolName;
	ok: boolean;
	output: string;
	revision: number;
}

export type SessionLifecycleAction =
	| "start"
	| "end"
	| "clone"
	| "reset"
	| "delete";

export interface SessionLifecycleRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	eventId: string;
	host: string;
	sessionId: string;
	action: SessionLifecycleAction;
	observedAtMs: number;
	targetSessionId?: string;
	projectId?: string;
	modelKey?: string;
	reason?: string;
	messages?: CanonicalMessage[];
	auxiliaryPolicy?: AuxiliaryRuntimePolicy;
}

export interface SessionLifecycleReceipt {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	eventId: string;
	sessionId: string;
	action: SessionLifecycleAction;
	accepted: boolean;
	revision: number;
	targetSessionId?: string;
}

export interface CacheFeedbackRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	eventId: string;
	host: string;
	sessionId: string;
	observedAtMs: number;
	usage: ContextUsageObservation;
	projectId?: string;
	modelKey?: string;
}

export interface CacheFeedbackReceipt {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	eventId: string;
	sessionId: string;
	accepted: boolean;
	revision: number;
	cumulativeCacheReadTokens: number;
	cumulativeCacheWriteTokens: number;
}

export type ToolEventPhase = "pre" | "post";

export interface ToolEventRequest {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	eventId: string;
	host: string;
	sessionId: string;
	observedAtMs: number;
	phase: ToolEventPhase;
	toolName: string;
	arguments?: Record<string, unknown>;
	result?: unknown;
	status?: string;
	durationMs?: number;
	toolCallId?: string;
	turnId?: string;
	taskId?: string;
}

export interface ToolEventReceipt {
	protocolVersion: typeof CORE_PROTOCOL_VERSION;
	eventId: string;
	sessionId: string;
	accepted: boolean;
	revision: number;
	triggersQueued: number;
}

export type ContextRuntimeCall =
	| { method: "context.compose"; params: ComposeContextRequest }
	| { method: "turn.observe"; params: ObserveTurnRequest }
	| { method: "tool.execute"; params: ExecuteContextToolRequest }
	| { method: "session.lifecycle"; params: SessionLifecycleRequest }
	| { method: "cache.observe"; params: CacheFeedbackRequest }
	| { method: "tool.observe"; params: ToolEventRequest }
	| { method: "maintenance.poll"; params: MaintenancePollRequest }
	| { method: "host.callback.resolve"; params: ResolveHostCallbackRequest };

export type ContextRuntimeResult =
	| ContextPlan
	| TurnObservationReceipt
	| ContextToolExecutionResult
	| SessionLifecycleReceipt
	| CacheFeedbackReceipt
	| ToolEventReceipt
	| MaintenancePollReceipt
	| HostCallbackResolutionReceipt;

export interface ContextMutation {
	target: { messageId: string; blockId?: string; blockIndex?: number };
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
	callbacks?: HostCallbackRequest[];
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
	const knownBlocks = new Map(
		request.messages.map((message) => [
			message.id,
			new Set(
				message.content.flatMap((block) =>
					block.id === undefined ? [] : [block.id],
				),
			),
		]),
	);
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
		if (
			mutation.target.blockId !== undefined &&
			mutation.target.blockIndex !== undefined
		) {
			throw new InvalidContextPlanError(
				"mutation target cannot contain both blockId and blockIndex",
			);
		}
		if (mutation.target.blockId !== undefined) {
			if (!request.capabilities.stablePartIds) {
				throw new InvalidContextPlanError(
					"host cannot materialize block-level mutations",
				);
			}
			if (
				!knownBlocks
					.get(mutation.target.messageId)
					?.has(mutation.target.blockId)
			) {
				throw new InvalidContextPlanError(
					`mutation references unknown block ${mutation.target.blockId}`,
				);
			}
		}
		if (mutation.target.blockIndex !== undefined) {
			if (!request.capabilities.blockIndexMutations) {
				throw new InvalidContextPlanError(
					"host cannot materialize block-index mutations",
				);
			}
			if (
				!Number.isInteger(mutation.target.blockIndex) ||
				mutation.target.blockIndex < 0 ||
				mutation.target.blockIndex >=
					(request.messages.find(
						(message) => message.id === mutation.target.messageId,
					)?.content.length ?? 0)
			) {
				throw new InvalidContextPlanError(
					`mutation references unknown block index ${String(mutation.target.blockIndex)}`,
				);
			}
		}
		if (mutation.operation === "replace" && mutation.content === undefined) {
			throw new InvalidContextPlanError("replace mutation requires content");
		}
		if (
			mutation.operation === "prefix_tag" &&
			!/^§\d+§$/.test(mutation.content ?? "")
		) {
			throw new InvalidContextPlanError(
				"prefix_tag mutation requires a canonical §N§ token",
			);
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
