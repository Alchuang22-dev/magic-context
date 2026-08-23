import {
	type AgentCapabilities,
	type CanonicalMessage,
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ContextPlan,
} from "@cortexkit/magic-context-protocol";

/** Host message codec and ContextPlan materializer at the Agent Adapter seam. */
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

/** Validate cross-host invariants; native role/tool legality stays Adapter-owned. */
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
