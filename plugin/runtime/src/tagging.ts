import { createHash } from "node:crypto";

import type {
	CanonicalBlock,
	CanonicalMessage,
	ComposeContextRequest,
	ContextMutation,
} from "@cortexkit/magic-context-core-plugin";

import type {
	RuntimeSessionIdentity,
	RuntimeSessionState,
	RuntimeStateStore,
	RuntimeTagKind,
	RuntimeTagRecord,
} from "./state-store";

const COMPLETE_TAG_PREFIX = /^(?:§\d+§\s*)+/;
const MALFORMED_TAG_PREFIX = /^(?:§\d+">§(?:\d+§)?\s*)+/;
const DANGLING_TAG_PREFIX = /^(?:§\d+(?!\.\d)[^\s§\w.]?\s*)+/;
const MAX_TAG_RECORDS = 100_000;

export function stripTagPrefix(value: string): string {
	let stripped = value;
	for (let pass = 0; pass < 8; pass += 1) {
		const previous = stripped;
		stripped = stripped.replace(MALFORMED_TAG_PREFIX, "");
		stripped = stripped.replace(COMPLETE_TAG_PREFIX, "");
		stripped = stripped.replace(DANGLING_TAG_PREFIX, "");
		if (stripped === previous) break;
	}
	return stripped;
}

export function prefixTag(tagNumber: number, value: string): string {
	return `§${tagNumber}§ ${stripTagPrefix(value)}`;
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

function blockText(block: CanonicalBlock): string {
	switch (block.kind) {
		case "text":
		case "thinking":
			return block.text;
		case "tool_call":
			return stableJson(block.input);
		case "tool_result":
			return stableJson(block.output);
		default:
			return stableJson(block.value);
	}
}

function tagKind(block: CanonicalBlock): RuntimeTagKind | undefined {
	if (block.kind === "text") return "message";
	if (block.kind === "tool_call" || block.kind === "tool_result") return "tool";
	if (block.kind === "file") return "file";
	return undefined;
}

function locatorKey(block: CanonicalBlock, index: number): string {
	return block.id ?? `${block.kind}:${index}`;
}

interface TagCandidate {
	entityKey: string;
	kind: RuntimeTagKind;
	message: CanonicalMessage;
	block: CanonicalBlock;
	blockIndex: number;
	callId?: string;
	ownerMessageId?: string;
	visible: boolean;
}

/**
 * Resolve tool identity by `(ownerMessageId, callId)` rather than bare callId.
 * Reused call IDs in later turns therefore cannot inherit an older tag's state.
 */
function collectCandidates(
	messages: readonly CanonicalMessage[],
): TagCandidate[] {
	const pendingOwners = new Map<string, string[]>();
	const candidates: TagCandidate[] = [];
	for (const message of messages) {
		for (
			let blockIndex = 0;
			blockIndex < message.content.length;
			blockIndex += 1
		) {
			const block = message.content[blockIndex];
			if (!block) continue;
			const kind = tagKind(block);
			if (!kind || message.role === "system" || message.synthetic) continue;
			if (block.kind === "tool_call") {
				const owners = pendingOwners.get(block.callId) ?? [];
				owners.push(message.id);
				pendingOwners.set(block.callId, owners);
				candidates.push({
					entityKey: `tool\0${message.id}\0${block.callId}`,
					kind,
					message,
					block,
					blockIndex,
					callId: block.callId,
					ownerMessageId: message.id,
					visible: false,
				});
				continue;
			}
			if (block.kind === "tool_result") {
				const owners = pendingOwners.get(block.callId);
				const ownerMessageId = owners?.shift() ?? message.id;
				if (owners?.length === 0) pendingOwners.delete(block.callId);
				candidates.push({
					entityKey: `tool\0${ownerMessageId}\0${block.callId}`,
					kind,
					message,
					block,
					blockIndex,
					callId: block.callId,
					ownerMessageId,
					visible: true,
				});
				continue;
			}
			const content = blockText(block);
			if (content.length === 0) continue;
			candidates.push({
				entityKey: `${kind}\0${message.id}\0${locatorKey(block, blockIndex)}`,
				kind,
				message,
				block,
				blockIndex,
				visible: block.kind === "text",
			});
		}
	}
	return candidates;
}

function recordForCandidate(
	tagNumber: number,
	candidate: TagCandidate,
	nowMs: number,
): RuntimeTagRecord {
	const text = blockText(candidate.block);
	return {
		tagNumber,
		entityKey: candidate.entityKey,
		kind: candidate.kind,
		messageId: candidate.message.id,
		messageOrdinal: candidate.message.ordinal,
		blockIndex: candidate.blockIndex,
		blockId: candidate.block.id,
		callId: candidate.callId,
		ownerMessageId: candidate.ownerMessageId,
		byteSize: Buffer.byteLength(text, "utf8"),
		tokenCount: Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3)),
		createdAtMs: nowMs,
	};
}

export interface TaggingResult {
	mutations: ContextMutation[];
	tagNumbersByOrdinal: Map<number, number[]>;
	fingerprint: string;
	estimatedTokens: number;
}

/** Deep host-neutral Module for stable tag allocation and render planning. */
export class RuntimeTagging {
	constructor(
		readonly store: RuntimeStateStore,
		readonly now: () => number = Date.now,
	) {}

	async synchronize(request: ComposeContextRequest): Promise<TaggingResult> {
		if (
			!request.capabilities.stablePartIds &&
			!request.capabilities.blockIndexMutations
		) {
			return {
				mutations: [],
				tagNumbersByOrdinal: new Map(),
				fingerprint: createHash("sha256").update("").digest("hex"),
				estimatedTokens: 0,
			};
		}
		const identity = { host: request.host, sessionId: request.sessionId };
		const candidates = collectCandidates(request.messages);
		return this.store.updateSession<TaggingResult>(identity, (state) => {
			const byKey = new Map(
				state.tags.records.map((record) => [record.entityKey, record]),
			);
			const mutations: ContextMutation[] = [];
			const tagNumbersByOrdinal = new Map<number, number[]>();
			let changed = false;
			const droppedTags = new Set(state.droppedTagNumbers);
			for (const candidate of candidates) {
				let record = byKey.get(candidate.entityKey);
				if (!record) {
					record = recordForCandidate(
						state.tags.nextTagNumber,
						candidate,
						this.now(),
					);
					state.tags.nextTagNumber += 1;
					state.tags.records.push(record);
					byKey.set(candidate.entityKey, record);
					changed = true;
				} else if (
					record.messageId !== candidate.message.id ||
					record.messageOrdinal !== candidate.message.ordinal ||
					record.blockIndex !== candidate.blockIndex ||
					record.blockId !== candidate.block.id
				) {
					Object.assign(
						record,
						recordForCandidate(record.tagNumber, candidate, record.createdAtMs),
					);
					changed = true;
				}
				const ordinalTags =
					tagNumbersByOrdinal.get(candidate.message.ordinal) ?? [];
				if (!ordinalTags.includes(record.tagNumber))
					ordinalTags.push(record.tagNumber);
				tagNumbersByOrdinal.set(candidate.message.ordinal, ordinalTags);
				if (!candidate.visible && !droppedTags.has(record.tagNumber)) continue;
				const target =
					candidate.block.id && request.capabilities.stablePartIds
						? {
								messageId: candidate.message.id,
								blockId: candidate.block.id,
							}
						: request.capabilities.blockIndexMutations
							? {
									messageId: candidate.message.id,
									blockIndex: candidate.blockIndex,
								}
							: undefined;
				if (target) {
					mutations.push(
						droppedTags.has(record.tagNumber)
							? { target, operation: "drop" }
							: {
									target,
									operation: "prefix_tag",
									content: `§${record.tagNumber}§`,
								},
					);
				}
			}
			if (state.tags.records.length > MAX_TAG_RECORDS) {
				state.tags.records = state.tags.records.slice(-MAX_TAG_RECORDS);
				changed = true;
			}
			if (changed) {
				state.revision += 1;
				state.lastCompose = undefined;
			}
			const fingerprint = createHash("sha256")
				.update(
					mutations
						.map(
							(mutation) =>
								`${mutation.target.messageId}:${mutation.target.blockId ?? mutation.target.blockIndex}:${mutation.operation}:${mutation.content ?? ""}`,
						)
						.join("\0"),
				)
				.digest("hex");
			return {
				state,
				result: {
					mutations,
					tagNumbersByOrdinal,
					fingerprint,
					estimatedTokens:
						mutations.filter((mutation) => mutation.operation === "prefix_tag")
							.length * 4,
				},
			};
		});
	}

	async records(identity: RuntimeSessionIdentity): Promise<RuntimeTagRecord[]> {
		return (await this.store.readSession(identity)).tags.records;
	}

	resolveTag(
		state: RuntimeSessionState,
		tagNumber: number,
	): RuntimeTagRecord | undefined {
		return state.tags.records.find((record) => record.tagNumber === tagNumber);
	}
}
