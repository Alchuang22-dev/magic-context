import { createHash, randomUUID } from "node:crypto";

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

export interface OpenCodeMessage {
	info: Record<string, unknown> & {
		id?: string;
		role?: string;
		sessionID?: string;
	};
	parts: Array<Record<string, unknown>>;
}

export type OpenCodeMessages = OpenCodeMessage[];

interface PartLocator {
	messageId: string;
	partIndex: number;
	kind: CanonicalBlock["kind"];
}

function messageId(message: OpenCodeMessage, index: number): string {
	if (message.info.id) return `opencode:${message.info.id}`;
	return `opencode:derived:${createHash("sha256")
		.update(`${index}:${JSON.stringify(message)}`)
		.digest("hex")
		.slice(0, 24)}`;
}

function partId(id: string, index: number, suffix: string): string {
	return `${id}:part:${index}:${suffix}`;
}

function canonicalParts(
	message: OpenCodeMessage,
	id: string,
	locators?: Map<string, PartLocator>,
): CanonicalBlock[] {
	const blocks: CanonicalBlock[] = [];
	for (let index = 0; index < message.parts.length; index += 1) {
		const part = message.parts[index] ?? {};
		const type = String(part.type ?? "opaque");
		const add = (block: CanonicalBlock, suffix: string) => {
			const blockId = partId(id, index, suffix);
			block.id = blockId;
			blocks.push(block);
			locators?.set(blockId, {
				messageId: id,
				partIndex: index,
				kind: block.kind,
			});
		};
		if (type === "text") {
			add({ kind: "text", text: String(part.text ?? "") }, "text");
		} else if (type === "reasoning" || type === "thinking") {
			add(
				{
					kind: "thinking",
					text: String(part.text ?? part.thinking ?? ""),
				},
				"thinking",
			);
		} else if (type === "tool" && typeof part.callID === "string") {
			const state =
				part.state && typeof part.state === "object"
					? (part.state as Record<string, unknown>)
					: {};
			add(
				{
					kind: "tool_call",
					callId: part.callID,
					name: String(part.tool ?? "unknown"),
					input: state.input ?? {},
				},
				"call",
			);
			if (state.output !== undefined) {
				add(
					{
						kind: "tool_result",
						callId: part.callID,
						name: String(part.tool ?? "unknown"),
						output: structuredClone(state.output),
						isError: state.status === "error",
					},
					"result",
				);
			}
		} else if (type === "file") {
			add({ kind: "file", value: structuredClone(part) }, "file");
		} else if (type === "image") {
			add({ kind: "image", value: structuredClone(part) }, "image");
		} else {
			add({ kind: "opaque", value: structuredClone(part) }, "opaque");
		}
	}
	return blocks;
}

function mutationText(
	part: Record<string, unknown>,
	kind: CanonicalBlock["kind"],
): string {
	if (kind === "tool_result") {
		const state = part.state as Record<string, unknown> | undefined;
		const output = state?.output;
		return typeof output === "string" ? output : JSON.stringify(output ?? null);
	}
	return String(part.text ?? part.thinking ?? "");
}

function mutatePart(
	part: Record<string, unknown>,
	kind: CanonicalBlock["kind"],
	mutation: ContextMutation,
): void {
	if (kind === "tool_result") {
		const state =
			part.state && typeof part.state === "object"
				? (part.state as Record<string, unknown>)
				: {};
		part.state = state;
		state.output =
			mutation.operation === "prefix_tag"
				? prefixTag(
						Number(mutation.content?.replaceAll("§", "")),
						mutationText(part, kind),
					)
				: (mutation.content ?? "");
		return;
	}
	const text =
		mutation.operation === "prefix_tag"
			? prefixTag(
					Number(mutation.content?.replaceAll("§", "")),
					mutationText(part, kind),
				)
			: (mutation.content ?? "");
	if ("thinking" in part && !("text" in part)) part.thinking = text;
	else part.text = text;
}

function injectionText(injection: ContextInjection): string {
	return typeof injection.content === "string"
		? injection.content
		: JSON.stringify(injection.content);
}

function inject(messages: OpenCodeMessages, injection: ContextInjection): void {
	const indexes = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => message.info.role === "user")
		.map(({ index }) => index);
	if (indexes.length === 0) return;
	const targetIndex =
		injection.slot === "tail_nudge" ? indexes.at(-1) : indexes[0];
	if (targetIndex === undefined) return;
	const part = { type: "text", text: injectionText(injection) };
	if (injection.slot === "volatile_delta")
		messages[targetIndex]?.parts.unshift(part);
	else messages[targetIndex]?.parts.push(part);
}

/** OpenCode-only codec; every policy decision remains runtime-owned. */
export class OpenCodeContextAdapter
	implements AgentContextAdapter<OpenCodeMessages>
{
	readonly host = "opencode";
	readonly capabilities = resolveCapabilities({
		stableMessageIds: true,
		stablePartIds: true,
		blockIndexMutations: true,
		usageObservation: true,
		auxiliaryLlm: true,
		toolRegistration: true,
		toolEvents: true,
		preRequestTransform: true,
	});

	snapshot(messages: OpenCodeMessages): CanonicalMessage[] {
		return messages.map((message, index) => {
			const id = messageId(message, index);
			return {
				id,
				ordinal: index + 1,
				role: String(message.info.role ?? "user"),
				content: canonicalParts(message, id),
			};
		});
	}

	materialize(messages: OpenCodeMessages, plan: ContextPlan): OpenCodeMessages {
		const locators = new Map<string, PartLocator>();
		const canonical = messages.map((message, index) => {
			const id = messageId(message, index);
			return {
				id,
				ordinal: index + 1,
				role: String(message.info.role ?? "user"),
				content: canonicalParts(message, id, locators),
			};
		});
		const byId = new Map(
			canonical.map((message, index) => [message.id, index]),
		);
		const retained = new Set(plan.retain.messageIds);
		const selected = messages.map((message) => structuredClone(message));
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
				else
					selected[messageIndex].parts = [
						{ type: "text", text: mutation.content ?? "" },
					];
				continue;
			}
			const blockId =
				mutation.target.blockId ??
				canonical[messageIndex].content[mutation.target.blockIndex ?? -1]?.id;
			const locator = blockId ? locators.get(blockId) : undefined;
			if (!locator) continue;
			if (mutation.operation === "drop") {
				const indexes = droppedParts.get(messageIndex) ?? new Set<number>();
				indexes.add(locator.partIndex);
				droppedParts.set(messageIndex, indexes);
			} else {
				const part = selected[messageIndex].parts[locator.partIndex];
				if (part) mutatePart(part, locator.kind, mutation);
			}
		}
		const output = selected.flatMap((message, index) => {
			if (!retained.has(canonical[index].id) || droppedMessages.has(index))
				return [];
			const partDrops = droppedParts.get(index);
			if (partDrops)
				message.parts = message.parts.filter(
					(_, partIndex) => !partDrops.has(partIndex),
				);
			return [message];
		});
		for (const injection of plan.injections) inject(output, injection);
		return output;
	}
}

export function openCodeDerivedSessionId(messages: OpenCodeMessages): string {
	return (
		[...messages].reverse().find((message) => message.info.sessionID)?.info
			.sessionID ?? `opencode-unbound-${randomUUID()}`
	);
}
