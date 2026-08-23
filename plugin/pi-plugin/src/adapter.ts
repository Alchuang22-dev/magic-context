import { createHash } from "node:crypto";

import {
	type AgentContextAdapter,
	type CanonicalBlock,
	type CanonicalMessage,
	type ContextInjection,
	type ContextMutation,
	type ContextPlan,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";
import { prefixTag } from "@cortexkit/magic-context-runtime";

export type PiContentPart = Record<string, unknown>;
export interface PiMessage {
	role: string;
	content: string | PiContentPart[];
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
}

export interface PiMessageBatch {
	messages: PiMessage[];
	/** Stable SessionEntry ids supplied by the Pi hook when available. */
	entryIds?: Array<string | undefined>;
}

interface PiLocator {
	messageIndex: number;
	partIndex: number;
	kind: CanonicalBlock["kind"];
}

function stableMessageId(batch: PiMessageBatch, index: number): string {
	const entryId = batch.entryIds?.[index];
	if (entryId) return `pi:entry:${entryId}`;
	const message = batch.messages[index];
	return `pi:derived:${createHash("sha256")
		.update(
			`${index}:${message?.timestamp ?? 0}:${message?.role}:${JSON.stringify(message?.content)}`,
		)
		.digest("hex")
		.slice(0, 24)}`;
}

function blockId(messageId: string, partIndex: number, kind: string): string {
	return `${messageId}:part:${partIndex}:${kind}`;
}

function snapshotBatch(
	batch: PiMessageBatch,
	locators?: Map<string, PiLocator>,
): CanonicalMessage[] {
	return batch.messages.map((message, messageIndex) => {
		const id = stableMessageId(batch, messageIndex);
		const blocks: CanonicalBlock[] = [];
		const add = (block: CanonicalBlock, partIndex: number, suffix: string) => {
			const idValue = blockId(id, partIndex, suffix);
			block.id = idValue;
			blocks.push(block);
			locators?.set(idValue, { messageIndex, partIndex, kind: block.kind });
		};
		if (message.role === "toolResult") {
			add(
				{
					kind: "tool_result",
					callId: message.toolCallId ?? "",
					name: message.toolName,
					output: structuredClone(message.content),
				},
				0,
				"result",
			);
		} else if (typeof message.content === "string") {
			add({ kind: "text", text: message.content }, 0, "text");
		} else {
			for (
				let partIndex = 0;
				partIndex < message.content.length;
				partIndex += 1
			) {
				const part = message.content[partIndex] ?? {};
				const type = String(part.type ?? "opaque");
				if (type === "text") {
					add(
						{ kind: "text", text: String(part.text ?? "") },
						partIndex,
						"text",
					);
				} else if (type === "thinking" || type === "reasoning") {
					add(
						{
							kind: "thinking",
							text: String(part.text ?? part.thinking ?? ""),
						},
						partIndex,
						"thinking",
					);
				} else if (type === "toolCall" && typeof part.id === "string") {
					add(
						{
							kind: "tool_call",
							callId: part.id,
							name: String(part.name ?? "unknown"),
							input: structuredClone(part.arguments ?? {}),
						},
						partIndex,
						"call",
					);
				} else if (type === "image") {
					add(
						{ kind: "image", value: structuredClone(part) },
						partIndex,
						"image",
					);
				} else {
					add(
						{ kind: "opaque", value: structuredClone(part) },
						partIndex,
						"opaque",
					);
				}
			}
		}
		return {
			id,
			ordinal: messageIndex + 1,
			role: message.role === "toolResult" ? "tool" : message.role,
			createdAtMs: message.timestamp,
			content: blocks,
		};
	});
}

function mutateText(
	message: PiMessage,
	partIndex: number,
	mutation: ContextMutation,
): void {
	const apply = (value: string) =>
		mutation.operation === "prefix_tag"
			? prefixTag(Number(mutation.content?.replaceAll("§", "")), value)
			: (mutation.content ?? "");
	if (typeof message.content === "string") {
		message.content = apply(message.content);
		return;
	}
	const part = message.content[partIndex];
	if (part) part.text = apply(String(part.text ?? part.thinking ?? ""));
}

function mutateToolResult(message: PiMessage, mutation: ContextMutation): void {
	const token = Number(mutation.content?.replaceAll("§", ""));
	if (typeof message.content === "string") {
		message.content =
			mutation.operation === "prefix_tag"
				? prefixTag(token, message.content)
				: (mutation.content ?? "");
		return;
	}
	const textPart = message.content.find((part) => part.type === "text");
	if (textPart) {
		textPart.text =
			mutation.operation === "prefix_tag"
				? prefixTag(token, String(textPart.text ?? ""))
				: (mutation.content ?? "");
	} else if (mutation.operation === "prefix_tag") {
		message.content.unshift({ type: "text", text: `§${token}§` });
	}
}

function inject(batch: PiMessageBatch, injection: ContextInjection): void {
	const userIndexes = batch.messages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => message.role === "user")
		.map(({ index }) => index);
	if (userIndexes.length === 0) return;
	const index =
		injection.slot === "tail_nudge" ? userIndexes.at(-1) : userIndexes[0];
	if (index === undefined) return;
	const message = batch.messages[index];
	if (!message) return;
	const text =
		typeof injection.content === "string"
			? injection.content
			: JSON.stringify(injection.content);
	if (typeof message.content === "string") {
		message.content =
			injection.slot === "volatile_delta"
				? `${text}\n\n${message.content}`
				: `${message.content}\n\n${text}`;
	} else if (injection.slot === "volatile_delta") {
		message.content.unshift({ type: "text", text });
	} else {
		message.content.push({ type: "text", text });
	}
}

/** Pi-only codec; branch/history policy stays behind the runtime Interface. */
export class PiContextAdapter implements AgentContextAdapter<PiMessageBatch> {
	readonly host = "pi";
	readonly capabilities = resolveCapabilities({
		stableMessageIds: true,
		stablePartIds: true,
		blockIndexMutations: true,
		usageObservation: true,
		auxiliaryLlm: true,
		toolRegistration: true,
		toolEvents: true,
		preRequestTransform: true,
		requestBlocking: true,
	});

	snapshot(batch: PiMessageBatch): CanonicalMessage[] {
		return snapshotBatch(batch);
	}

	materialize(batch: PiMessageBatch, plan: ContextPlan): PiMessageBatch {
		const locators = new Map<string, PiLocator>();
		const canonical = snapshotBatch(batch, locators);
		const byId = new Map(
			canonical.map((message, index) => [message.id, index]),
		);
		const retained = new Set(plan.retain.messageIds);
		const output: PiMessageBatch = {
			messages: batch.messages.map((message) => structuredClone(message)),
			entryIds: batch.entryIds ? [...batch.entryIds] : undefined,
		};
		const droppedMessages = new Set<number>();
		const droppedParts = new Map<number, Set<number>>();
		for (const mutation of plan.mutations) {
			const messageIndex = byId.get(mutation.target.messageId);
			if (
				messageIndex === undefined ||
				!retained.has(mutation.target.messageId)
			)
				continue;
			if (
				!mutation.target.blockId &&
				mutation.target.blockIndex === undefined
			) {
				if (mutation.operation === "drop") droppedMessages.add(messageIndex);
				else output.messages[messageIndex].content = mutation.content ?? "";
				continue;
			}
			const blockIdValue =
				mutation.target.blockId ??
				canonical[messageIndex].content[mutation.target.blockIndex ?? -1]?.id;
			const locator = blockIdValue ? locators.get(blockIdValue) : undefined;
			if (!locator) continue;
			if (mutation.operation === "drop") {
				if (locator.kind === "tool_result") droppedMessages.add(messageIndex);
				else {
					const parts = droppedParts.get(messageIndex) ?? new Set<number>();
					parts.add(locator.partIndex);
					droppedParts.set(messageIndex, parts);
				}
			} else if (locator.kind === "tool_result") {
				mutateToolResult(output.messages[messageIndex], mutation);
			} else {
				mutateText(output.messages[messageIndex], locator.partIndex, mutation);
			}
		}
		const keptMessages: PiMessage[] = [];
		const keptIds: Array<string | undefined> = [];
		for (let index = 0; index < output.messages.length; index += 1) {
			if (!retained.has(canonical[index].id) || droppedMessages.has(index))
				continue;
			const message = output.messages[index];
			const partDrops = droppedParts.get(index);
			if (partDrops && Array.isArray(message.content)) {
				message.content = message.content.filter(
					(_, partIndex) => !partDrops.has(partIndex),
				);
			}
			keptMessages.push(message);
			keptIds.push(output.entryIds?.[index]);
		}
		output.messages = keptMessages;
		if (output.entryIds) output.entryIds = keptIds;
		for (const injection of plan.injections) inject(output, injection);
		return output;
	}
}
