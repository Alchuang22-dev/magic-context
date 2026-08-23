import {
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ContextUsageObservation,
	type ObserveTurnRequest,
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
	return structuredClone(value) as unknown as ObserveTurnRequest;
}

export function validateUsageObservation(
	value: ContextUsageObservation | undefined,
): ContextUsageObservation | undefined {
	validateUsage(value, "usage");
	return value;
}
