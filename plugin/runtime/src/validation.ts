import {
	type CacheFeedbackRequest,
	CONTEXT_TOOL_NAMES,
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ContextUsageObservation,
	type ExecuteContextToolRequest,
	MEMORY_CATEGORIES,
	type ObserveTurnRequest,
	type SessionLifecycleRequest,
	type ToolEventRequest,
} from "@cortexkit/magic-context-core-plugin";

export class InvalidRuntimeRequestError extends Error {
	readonly code = "INVALID_REQUEST";

	constructor(message: string) {
		super(message);
		this.name = "InvalidRuntimeRequestError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new InvalidRuntimeRequestError(`${field} must be a non-empty string`);
	}
}

function requireOptionalString(value: unknown, field: string): void {
	if (value === undefined) return;
	requireString(value, field);
}

function requireStringValue(
	value: unknown,
	field: string,
): asserts value is string {
	if (typeof value !== "string") {
		throw new InvalidRuntimeRequestError(`${field} must be a string`);
	}
}

function requireFiniteNonNegative(
	value: unknown,
	field: string,
	options: { optional?: boolean } = {},
): asserts value is number | undefined {
	if (value === undefined && options.optional) return;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new InvalidRuntimeRequestError(
			`${field} must be a finite non-negative number`,
		);
	}
}

function validateUsage(value: unknown, field: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) {
		throw new InvalidRuntimeRequestError(`${field} must be an object`);
	}
	for (const key of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokens",
		"contextLimitTokens",
	] as const) {
		requireFiniteNonNegative(value[key], `${field}.${key}`, { optional: true });
	}
}

function validateMessages(value: unknown): void {
	if (!Array.isArray(value)) {
		throw new InvalidRuntimeRequestError("messages must be an array");
	}
	const ids = new Set<string>();
	for (const [index, message] of value.entries()) {
		if (!isRecord(message)) {
			throw new InvalidRuntimeRequestError(
				`messages[${index}] must be an object`,
			);
		}
		requireString(message.id, `messages[${index}].id`);
		if (ids.has(message.id)) {
			throw new InvalidRuntimeRequestError(
				`duplicate message id ${message.id}`,
			);
		}
		ids.add(message.id);
		if (!Number.isInteger(message.ordinal) || Number(message.ordinal) < 0) {
			throw new InvalidRuntimeRequestError(
				`messages[${index}].ordinal must be a non-negative integer`,
			);
		}
		requireString(message.role, `messages[${index}].role`);
		if (!Array.isArray(message.content)) {
			throw new InvalidRuntimeRequestError(
				`messages[${index}].content must be an array`,
			);
		}
		for (const [blockIndex, block] of message.content.entries()) {
			if (!isRecord(block) || typeof block.kind !== "string") {
				throw new InvalidRuntimeRequestError(
					`messages[${index}].content[${blockIndex}] must have a kind`,
				);
			}
			const blockField = `messages[${index}].content[${blockIndex}]`;
			switch (block.kind) {
				case "text":
				case "thinking":
					requireStringValue(block.text, `${blockField}.text`);
					break;
				case "tool_call":
					requireString(block.callId, `${blockField}.callId`);
					requireString(block.name, `${blockField}.name`);
					break;
				case "tool_result":
					requireString(block.callId, `${blockField}.callId`);
					break;
				case "image":
				case "file":
				case "opaque":
					if (!("value" in block)) {
						throw new InvalidRuntimeRequestError(
							`${blockField}.value is required`,
						);
					}
					break;
				default:
					throw new InvalidRuntimeRequestError(
						`${blockField}.kind is unsupported`,
					);
			}
		}
	}
}

function validateMemoryCandidates(value: unknown): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		throw new InvalidRuntimeRequestError("memoryCandidates must be an array");
	}
	if (value.length > 128) {
		throw new InvalidRuntimeRequestError(
			"memoryCandidates must contain at most 128 items",
		);
	}
	const categories = new Set<string>(MEMORY_CATEGORIES);
	const scopes = new Set(["project", "ecosystem", "universe"]);
	const sourceTypes = new Set(["historian", "agent", "dreamer", "tool"]);
	for (const [index, candidate] of value.entries()) {
		const field = `memoryCandidates[${index}]`;
		if (!isRecord(candidate)) {
			throw new InvalidRuntimeRequestError(`${field} must be an object`);
		}
		if (
			typeof candidate.category !== "string" ||
			!categories.has(candidate.category)
		) {
			throw new InvalidRuntimeRequestError(`${field}.category is unsupported`);
		}
		requireString(candidate.content, `${field}.content`);
		if (candidate.content.trim() === "") {
			throw new InvalidRuntimeRequestError(
				`${field}.content must not be blank`,
			);
		}
		if (candidate.content.length > 64_000) {
			throw new InvalidRuntimeRequestError(
				`${field}.content must not exceed 64000 characters`,
			);
		}
		if (candidate.importance !== undefined) {
			requireFiniteNonNegative(candidate.importance, `${field}.importance`);
			if (Number(candidate.importance) > 100) {
				throw new InvalidRuntimeRequestError(
					`${field}.importance must not exceed 100`,
				);
			}
		}
		if (
			candidate.scope !== undefined &&
			(typeof candidate.scope !== "string" || !scopes.has(candidate.scope))
		) {
			throw new InvalidRuntimeRequestError(`${field}.scope is unsupported`);
		}
		if (
			candidate.sourceType !== undefined &&
			(typeof candidate.sourceType !== "string" ||
				!sourceTypes.has(candidate.sourceType))
		) {
			throw new InvalidRuntimeRequestError(
				`${field}.sourceType is unsupported`,
			);
		}
		if (
			candidate.shareable !== undefined &&
			typeof candidate.shareable !== "boolean"
		) {
			throw new InvalidRuntimeRequestError(
				`${field}.shareable must be a boolean`,
			);
		}
		requireFiniteNonNegative(candidate.expiresAtMs, `${field}.expiresAtMs`, {
			optional: true,
		});
		if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
			throw new InvalidRuntimeRequestError(
				`${field}.metadata must be an object`,
			);
		}
		if (candidate.metadata !== undefined) {
			try {
				if (JSON.stringify(candidate.metadata).length > 64_000) {
					throw new Error("metadata too large");
				}
			} catch {
				throw new InvalidRuntimeRequestError(
					`${field}.metadata must be bounded JSON`,
				);
			}
		}
	}
}

function validateCommon(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) {
		throw new InvalidRuntimeRequestError("params must be an object");
	}
	if (value.protocolVersion !== CORE_PROTOCOL_VERSION) {
		throw new InvalidRuntimeRequestError(
			`unsupported protocol version ${String(value.protocolVersion)}`,
		);
	}
	requireString(value.host, "host");
	requireString(value.sessionId, "sessionId");
	validateMessages(value.messages);
	validateUsage(value.usage, "usage");
}

function validateRuntimeIdentity(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) {
		throw new InvalidRuntimeRequestError("params must be an object");
	}
	if (value.protocolVersion !== CORE_PROTOCOL_VERSION) {
		throw new InvalidRuntimeRequestError(
			`unsupported protocol version ${String(value.protocolVersion)}`,
		);
	}
	requireString(value.host, "host");
	requireString(value.sessionId, "sessionId");
}

export function validateComposeRequest(value: unknown): ComposeContextRequest {
	validateCommon(value);
	requireString(value.requestId, "requestId");
	requireOptionalString(value.turnId, "turnId");
	requireOptionalString(value.projectId, "projectId");
	requireOptionalString(value.modelKey, "modelKey");
	requireFiniteNonNegative(value.budgetTokens, "budgetTokens");
	if (!isRecord(value.capabilities)) {
		throw new InvalidRuntimeRequestError("capabilities must be an object");
	}
	for (const capability of [
		"preRequestTransform",
		"stableMessageIds",
		"stablePartIds",
		"usageObservation",
		"auxiliaryLlm",
		"toolRegistration",
		"toolEvents",
		"requestBlocking",
		"systemSuffixInjection",
		"promptCacheFacts",
	] as const) {
		if (typeof value.capabilities[capability] !== "boolean") {
			throw new InvalidRuntimeRequestError(
				`capabilities.${capability} must be a boolean`,
			);
		}
	}
	return structuredClone(value) as unknown as ComposeContextRequest;
}

export function validateObserveRequest(value: unknown): ObserveTurnRequest {
	validateCommon(value);
	requireString(value.observationId, "observationId");
	requireOptionalString(value.turnId, "turnId");
	requireOptionalString(value.taskId, "taskId");
	requireOptionalString(value.projectId, "projectId");
	requireOptionalString(value.modelKey, "modelKey");
	requireFiniteNonNegative(value.observedAtMs, "observedAtMs");
	if (!isRecord(value.outcome)) {
		throw new InvalidRuntimeRequestError("outcome must be an object");
	}
	if (
		typeof value.outcome.interrupted !== "boolean" ||
		typeof value.outcome.failed !== "boolean"
	) {
		throw new InvalidRuntimeRequestError(
			"outcome.interrupted and outcome.failed must be booleans",
		);
	}
	requireOptionalString(value.outcome.exitReason, "outcome.exitReason");
	validateMemoryCandidates(value.memoryCandidates);
	return structuredClone(value) as unknown as ObserveTurnRequest;
}

export function validateToolExecuteRequest(
	value: unknown,
): ExecuteContextToolRequest {
	validateRuntimeIdentity(value);
	requireString(value.requestId, "requestId");
	if (!(CONTEXT_TOOL_NAMES as readonly unknown[]).includes(value.toolName)) {
		throw new InvalidRuntimeRequestError("toolName is unsupported");
	}
	if (!isRecord(value.arguments)) {
		throw new InvalidRuntimeRequestError("arguments must be an object");
	}
	if (value.messages !== undefined) validateMessages(value.messages);
	requireFiniteNonNegative(value.invokedAtMs, "invokedAtMs");
	requireOptionalString(value.projectId, "projectId");
	requireOptionalString(value.modelKey, "modelKey");
	return structuredClone(value) as unknown as ExecuteContextToolRequest;
}

export function validateSessionLifecycleRequest(
	value: unknown,
): SessionLifecycleRequest {
	validateRuntimeIdentity(value);
	requireString(value.eventId, "eventId");
	if (
		typeof value.action !== "string" ||
		!["start", "end", "clone", "reset", "delete"].includes(value.action)
	) {
		throw new InvalidRuntimeRequestError("action is unsupported");
	}
	requireFiniteNonNegative(value.observedAtMs, "observedAtMs");
	requireOptionalString(value.targetSessionId, "targetSessionId");
	requireOptionalString(value.projectId, "projectId");
	requireOptionalString(value.modelKey, "modelKey");
	requireOptionalString(value.reason, "reason");
	if (value.messages !== undefined) validateMessages(value.messages);
	if (value.action === "clone" && !value.targetSessionId) {
		throw new InvalidRuntimeRequestError(
			"targetSessionId is required for clone",
		);
	}
	return structuredClone(value) as unknown as SessionLifecycleRequest;
}

export function validateCacheFeedbackRequest(
	value: unknown,
): CacheFeedbackRequest {
	validateRuntimeIdentity(value);
	requireString(value.eventId, "eventId");
	requireFiniteNonNegative(value.observedAtMs, "observedAtMs");
	if (!isRecord(value.usage)) {
		throw new InvalidRuntimeRequestError("usage must be an object");
	}
	validateUsage(value.usage, "usage");
	requireOptionalString(value.projectId, "projectId");
	requireOptionalString(value.modelKey, "modelKey");
	return structuredClone(value) as unknown as CacheFeedbackRequest;
}

export function validateToolEventRequest(value: unknown): ToolEventRequest {
	validateRuntimeIdentity(value);
	requireString(value.eventId, "eventId");
	requireFiniteNonNegative(value.observedAtMs, "observedAtMs");
	if (value.phase !== "pre" && value.phase !== "post") {
		throw new InvalidRuntimeRequestError("phase must be pre or post");
	}
	requireString(value.toolName, "toolName");
	if (value.arguments !== undefined && !isRecord(value.arguments)) {
		throw new InvalidRuntimeRequestError("arguments must be an object");
	}
	requireFiniteNonNegative(value.durationMs, "durationMs", { optional: true });
	for (const field of ["status", "toolCallId", "turnId", "taskId"] as const) {
		requireOptionalString(value[field], field);
	}
	return structuredClone(value) as unknown as ToolEventRequest;
}

export function validateUsageObservation(
	value: ContextUsageObservation | undefined,
): ContextUsageObservation | undefined {
	validateUsage(value, "usage");
	return value;
}
