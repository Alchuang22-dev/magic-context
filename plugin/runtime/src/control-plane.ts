import { createHash } from "node:crypto";

import {
	type CacheFeedbackReceipt,
	type CacheFeedbackRequest,
	type CanonicalBlock,
	type CanonicalMessage,
	CONTEXT_TOOL_NAMES,
	CORE_PROTOCOL_VERSION,
	type ContextToolExecutionResult,
	type ExecuteContextToolRequest,
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type SessionLifecycleReceipt,
	type SessionLifecycleRequest,
	type ToolEventReceipt,
	type ToolEventRequest,
} from "@cortexkit/magic-context-core-plugin";

import { memoryProjectKey, type RuntimeMemory } from "./memory";
import type {
	RuntimeAutomaticTrigger,
	RuntimeNote,
	RuntimeSessionIdentity,
	RuntimeSessionState,
	RuntimeStateStore,
} from "./state-store";

const MAX_TOOL_RESULTS = 64;
const MAX_TOOL_EVENTS = 128;
const MAX_LIFECYCLE_EVENTS = 64;
const MAX_PENDING_TRIGGERS = 16;
const LARGE_TOOL_RESULT_CHARACTERS = 8_000;
const EXPAND_CHARACTER_BUDGET = 60_000;

function identity(value: {
	host: string;
	sessionId: string;
}): RuntimeSessionIdentity {
	return { host: value.host, sessionId: value.sessionId };
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function finite(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function stringArg(
	args: Record<string, unknown>,
	name: string,
): string | undefined {
	const value = args[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArray(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is number => Number.isInteger(item) && Number(item) > 0,
	);
}

function canonicalBlockText(block: CanonicalBlock): string {
	switch (block.kind) {
		case "text":
		case "thinking":
			return block.text;
		case "tool_call":
			return `${block.name}(${stableJson(block.input)})`;
		case "tool_result":
			return `${block.name ?? "tool"}: ${stableJson(block.output)}`;
		default:
			return stableJson(block.value);
	}
}

function messageText(message: CanonicalMessage): string {
	return message.content.map(canonicalBlockText).filter(Boolean).join("\n");
}

function roleLabel(role: string): string {
	return role === "user"
		? "U"
		: role === "assistant"
			? "A"
			: role === "system"
				? "S"
				: "T";
}

function queryTerms(value: string): string[] {
	return [
		...new Set(
			(
				value.toLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}_./:-]+/gu) ?? []
			).filter(Boolean),
		),
	];
}

function lexicalScore(query: string, content: string): number {
	const normalizedQuery = query.toLowerCase();
	const normalizedContent = content.toLowerCase();
	const terms = queryTerms(normalizedQuery);
	if (terms.length === 0) return 0;
	const overlap = terms.filter((term) =>
		normalizedContent.includes(term),
	).length;
	if (overlap === 0) return 0;
	return Math.min(
		1,
		overlap / terms.length +
			(normalizedContent.includes(normalizedQuery) ? 0.25 : 0),
	);
}

function projectKey(request: ExecuteContextToolRequest): string {
	return memoryProjectKey(request);
}

function requestMessages(
	request: ExecuteContextToolRequest,
	state: RuntimeSessionState,
): CanonicalMessage[] {
	return (
		request.messages ??
		state.latestObservation?.messages ??
		state.lifecycleMessages ??
		[]
	);
}

function parseOrdinalRanges(raw: string): number[] {
	const result = new Set<number>();
	for (const token of raw.split(",")) {
		const normalized = token.trim().replaceAll("§", "");
		if (!normalized) continue;
		const range = normalized.match(/^(\d+)\s*-\s*(\d+)$/);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (start < 1 || end < start || end - start > 10_000) {
				throw new Error(`invalid range ${token.trim()}`);
			}
			for (let ordinal = start; ordinal <= end; ordinal += 1) {
				result.add(ordinal);
			}
			continue;
		}
		if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
			throw new Error(`invalid ordinal ${token.trim()}`);
		}
		result.add(Number(normalized));
	}
	return [...result].sort((left, right) => left - right);
}

function trigger(
	kind: RuntimeAutomaticTrigger["kind"],
	content: string,
	createdAtMs: number,
	seed: string,
): RuntimeAutomaticTrigger {
	return {
		id: createHash("sha256")
			.update(kind)
			.update("\0")
			.update(seed)
			.digest("hex")
			.slice(0, 24),
		kind,
		content,
		createdAtMs,
	};
}

function addTrigger(
	state: RuntimeSessionState,
	item: RuntimeAutomaticTrigger,
): boolean {
	if (state.pendingTriggers.some((existing) => existing.id === item.id)) {
		return false;
	}
	state.pendingTriggers = [...state.pendingTriggers, item].slice(
		-MAX_PENDING_TRIGGERS,
	);
	return true;
}

function lifecycleReceipt(
	request: SessionLifecycleRequest,
	accepted: boolean,
	revision: number,
): SessionLifecycleReceipt {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		eventId: request.eventId,
		sessionId: request.sessionId,
		action: request.action,
		accepted,
		revision,
		...(request.targetSessionId
			? { targetSessionId: request.targetSessionId }
			: {}),
	};
}

export class RuntimeControlPlane {
	constructor(
		readonly store: RuntimeStateStore,
		readonly memory: RuntimeMemory,
		readonly now: () => number = Date.now,
	) {}

	async executeTool(
		request: ExecuteContextToolRequest,
	): Promise<ContextToolExecutionResult> {
		if (!(CONTEXT_TOOL_NAMES as readonly string[]).includes(request.toolName)) {
			throw new Error(`unknown context tool ${request.toolName}`);
		}
		const sessionIdentity = identity(request);
		const snapshot = await this.store.readSession(sessionIdentity);
		const cached = snapshot.recentToolResults.find(
			(result) => result.requestId === request.requestId,
		);
		if (cached) return cached;

		let output: string;
		try {
			switch (request.toolName) {
				case "ctx_search":
					output = await this.#search(request, snapshot);
					break;
				case "ctx_memory":
					output = await this.#memory(request);
					break;
				case "ctx_expand":
					output = this.#expand(request, snapshot);
					break;
				case "ctx_reduce":
					output = await this.#reduce(request, snapshot);
					break;
				case "ctx_note":
					output = await this.#note(request, snapshot);
					break;
			}
		} catch (error) {
			output = `Error: ${error instanceof Error ? error.message : String(error)}`;
		}

		return this.store.updateSession(sessionIdentity, (state) => {
			const prior = state.recentToolResults.find(
				(result) => result.requestId === request.requestId,
			);
			if (prior) return { state, result: prior };
			const result: ContextToolExecutionResult = {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: request.requestId,
				sessionId: request.sessionId,
				toolName: request.toolName,
				ok: !output.startsWith("Error:"),
				output,
				revision: state.revision + 1,
			};
			return {
				state: {
					...state,
					revision: result.revision,
					projectId: request.projectId ?? state.projectId,
					modelKey: request.modelKey ?? state.modelKey,
					recentToolResults: [...state.recentToolResults, result].slice(
						-MAX_TOOL_RESULTS,
					),
					lastCompose: undefined,
				},
				result,
			};
		});
	}

	async observeCache(
		request: CacheFeedbackRequest,
	): Promise<CacheFeedbackReceipt> {
		return this.store.updateSession<CacheFeedbackReceipt>(
			identity(request),
			(state) => {
				if (state.cacheFeedback.recentEventIds.includes(request.eventId)) {
					return {
						state,
						result: {
							protocolVersion: CORE_PROTOCOL_VERSION,
							eventId: request.eventId,
							sessionId: request.sessionId,
							accepted: false,
							revision: state.revision,
							cumulativeCacheReadTokens:
								state.cacheFeedback.cumulativeCacheReadTokens,
							cumulativeCacheWriteTokens:
								state.cacheFeedback.cumulativeCacheWriteTokens,
						},
					};
				}
				const read = finite(request.usage.cacheReadTokens, 0);
				const write = finite(request.usage.cacheWriteTokens, 0);
				state.cacheFeedback = {
					latest: request,
					cumulativeCacheReadTokens:
						state.cacheFeedback.cumulativeCacheReadTokens + read,
					cumulativeCacheWriteTokens:
						state.cacheFeedback.cumulativeCacheWriteTokens + write,
					recentEventIds: [
						...state.cacheFeedback.recentEventIds,
						request.eventId,
					].slice(-128),
				};
				state.latestUsage = request.usage;
				state.projectId = request.projectId ?? state.projectId;
				state.modelKey = request.modelKey ?? state.modelKey;
				const pressureTokens =
					finite(request.usage.inputTokens, 0) + read + write;
				const limit = finite(request.usage.contextLimitTokens, 0);
				if (limit > 0 && pressureTokens / limit >= 0.85) {
					addTrigger(
						state,
						trigger(
							"cache_pressure",
							"Context/cache pressure is high. Prefer ctx_reduce for stale message ordinals before requesting more large tool output.",
							request.observedAtMs,
							request.eventId,
						),
					);
				}
				state.revision += 1;
				state.lastCompose = undefined;
				return {
					state,
					result: {
						protocolVersion: CORE_PROTOCOL_VERSION,
						eventId: request.eventId,
						sessionId: request.sessionId,
						accepted: true,
						revision: state.revision,
						cumulativeCacheReadTokens:
							state.cacheFeedback.cumulativeCacheReadTokens,
						cumulativeCacheWriteTokens:
							state.cacheFeedback.cumulativeCacheWriteTokens,
					},
				};
			},
		);
	}

	async observeTool(request: ToolEventRequest): Promise<ToolEventReceipt> {
		return this.store.updateSession<ToolEventReceipt>(
			identity(request),
			(state) => {
				if (
					state.toolEvents.some((event) => event.eventId === request.eventId)
				) {
					return {
						state,
						result: {
							protocolVersion: CORE_PROTOCOL_VERSION,
							eventId: request.eventId,
							sessionId: request.sessionId,
							accepted: false,
							revision: state.revision,
							triggersQueued: 0,
						},
					};
				}
				const resultText =
					request.result === undefined ? "" : stableJson(request.result);
				const resultCharacters =
					request.result &&
					typeof request.result === "object" &&
					"truncated" in request.result &&
					request.result.truncated === true &&
					"characters" in request.result &&
					typeof request.result.characters === "number"
						? request.result.characters
						: resultText.length;
				state.toolEvents = [
					...state.toolEvents,
					{
						eventId: request.eventId,
						phase: request.phase,
						toolName: request.toolName,
						observedAtMs: request.observedAtMs,
						status: request.status,
						durationMs: request.durationMs,
						resultCharacters,
					},
				].slice(-MAX_TOOL_EVENTS);
				let triggersQueued = 0;
				const succeeded =
					request.phase === "post" &&
					(!request.status ||
						request.status === "ok" ||
						request.status === "success");
				if (
					succeeded &&
					!request.toolName.startsWith("ctx_") &&
					resultCharacters >= LARGE_TOOL_RESULT_CHARACTERS
				) {
					triggersQueued += Number(
						addTrigger(
							state,
							trigger(
								"large_tool_result",
								`Tool ${request.toolName} returned ${resultCharacters} characters. After extracting what matters, use ctx_reduce on stale message ordinals; ctx_expand can recover the stored payload later.`,
								request.observedAtMs,
								request.eventId,
							),
						),
					);
				}
				if (succeeded) {
					for (const note of state.notes) {
						const match = note.surfaceCondition?.match(
							/^tool:\s*([\w.:-]+)\s*$/i,
						);
						if (
							note.status !== "pending" ||
							!match ||
							match[1].toLowerCase() !== request.toolName.toLowerCase()
						) {
							continue;
						}
						note.status = "ready";
						note.readyReason = `tool:${request.toolName} completed`;
						note.updatedAtMs = request.observedAtMs;
						triggersQueued += Number(
							addTrigger(
								state,
								trigger(
									"smart_note_ready",
									`Smart note #${note.id} is ready: ${note.content}`,
									request.observedAtMs,
									`${request.eventId}:${note.id}`,
								),
							),
						);
					}
				}
				state.revision += 1;
				state.lastCompose = undefined;
				return {
					state,
					result: {
						protocolVersion: CORE_PROTOCOL_VERSION,
						eventId: request.eventId,
						sessionId: request.sessionId,
						accepted: true,
						revision: state.revision,
						triggersQueued,
					},
				};
			},
		);
	}

	async lifecycle(
		request: SessionLifecycleRequest,
	): Promise<SessionLifecycleReceipt> {
		const sessionIdentity = identity(request);
		const snapshot = await this.store.readSession(sessionIdentity);
		if (
			snapshot.lifecycleEvents.some(
				(event) => event.eventId === request.eventId,
			)
		) {
			return lifecycleReceipt(request, false, snapshot.revision);
		}
		if (request.action === "delete") {
			const revision = snapshot.revision;
			const accepted = await this.store.deleteSession(sessionIdentity);
			return lifecycleReceipt(request, accepted, revision);
		}
		if (request.action === "reset") {
			await this.store.deleteSession(sessionIdentity);
			return this.store.updateSession(sessionIdentity, (state) => {
				state.revision = 1;
				state.lifecycleEvents = [this.#lifecycleRecord(request)];
				return {
					state,
					result: lifecycleReceipt(request, true, state.revision),
				};
			});
		}
		if (request.action === "clone") {
			const targetIdentity = {
				host: request.host,
				sessionId: request.targetSessionId as string,
			};
			return this.store.updateSession(targetIdentity, (current) => {
				if (
					current.lifecycleEvents.some(
						(event) => event.eventId === request.eventId,
					)
				) {
					return {
						state: current,
						result: lifecycleReceipt(request, false, current.revision),
					};
				}
				const cloned: RuntimeSessionState = {
					...structuredClone(snapshot),
					host: targetIdentity.host,
					sessionId: targetIdentity.sessionId,
					revision: Math.max(current.revision, snapshot.revision) + 1,
					lastCompose: undefined,
					recentToolResults: [],
					auxiliary: {
						...structuredClone(snapshot.auxiliary),
						// Callback leases are session-bound reverse RPCs and must never
						// cross the clone Seam. Published compartments remain reusable.
						jobs: [],
						completedCallbackIds: [],
						recentSidekickQueryHashes: [],
					},
					lifecycleEvents: [
						...snapshot.lifecycleEvents,
						this.#lifecycleRecord(request),
					].slice(-MAX_LIFECYCLE_EVENTS),
				};
				return {
					state: cloned,
					result: lifecycleReceipt(request, true, cloned.revision),
				};
			});
		}
		return this.store.updateSession(sessionIdentity, (state) => {
			state.revision += 1;
			state.projectId = request.projectId ?? state.projectId;
			state.modelKey = request.modelKey ?? state.modelKey;
			if (request.action === "end" && request.messages) {
				state.lifecycleMessages = request.messages;
			}
			state.lifecycleEvents = [
				...state.lifecycleEvents,
				this.#lifecycleRecord(request),
			].slice(-MAX_LIFECYCLE_EVENTS);
			state.lastCompose = undefined;
			return { state, result: lifecycleReceipt(request, true, state.revision) };
		});
	}

	#lifecycleRecord(request: SessionLifecycleRequest) {
		return {
			eventId: request.eventId,
			action: request.action,
			observedAtMs: request.observedAtMs,
			reason: request.reason,
			targetSessionId: request.targetSessionId,
		};
	}

	async #search(
		request: ExecuteContextToolRequest,
		state: RuntimeSessionState,
	): Promise<string> {
		const query = stringArg(request.arguments, "query");
		if (!query) return "Error: 'query' is required.";
		const limit = Math.max(
			1,
			Math.min(50, Math.floor(finite(request.arguments.limit, 10))),
		);
		const rawSources = request.arguments.sources;
		const sources = new Set(
			Array.isArray(rawSources)
				? rawSources.filter(
						(value): value is string => typeof value === "string",
					)
				: ["memory", "message", "note"],
		);
		const results: Array<{ score: number; text: string; memoryId?: number }> =
			[];
		if (sources.has("memory")) {
			const recalled = await this.memory.recall({
				projectKey: projectKey(request),
				query,
				limit,
				nowMs: request.invokedAtMs,
			});
			for (const item of recalled.items) {
				results.push({
					score: item.score,
					memoryId: item.memory.id,
					text: `[memory] score=${item.score.toFixed(2)} id=${item.memory.id} category=${item.memory.category}\n${item.memory.content}`,
				});
			}
		}
		if (sources.has("message")) {
			for (const message of requestMessages(request, state)) {
				const content = messageText(message);
				const score = lexicalScore(query, content);
				if (score <= 0) continue;
				results.push({
					score,
					text: `[message] score=${score.toFixed(2)} ordinal=${message.ordinal} role=${message.role}\n${content.slice(0, 2_000)}`,
				});
			}
		}
		if (sources.has("note")) {
			for (const note of state.notes) {
				if (note.status === "dismissed") continue;
				const score = lexicalScore(query, note.content);
				if (score <= 0) continue;
				results.push({
					score,
					text: `[note] score=${score.toFixed(2)} id=#${note.id} status=${note.status}${note.anchorOrdinal ? ` @msg ${note.anchorOrdinal}` : ""}\n${note.content}`,
				});
			}
		}
		const selected = results
			.sort((left, right) => right.score - left.score)
			.slice(0, limit);
		await this.memory.recordRetrieval(
			projectKey(request),
			selected.flatMap((result) =>
				result.memoryId === undefined ? [] : [result.memoryId],
			),
			request.invokedAtMs,
		);
		if (selected.length === 0) {
			return `No results found for "${query}".`;
		}
		return `Found ${selected.length} result${selected.length === 1 ? "" : "s"} for "${query}":\n\n${selected
			.map((result, index) => `[${index + 1}] ${result.text}`)
			.join("\n\n")}\n\nUse ctx_expand(message=N) for a full stored message.`;
	}

	async #memory(request: ExecuteContextToolRequest): Promise<string> {
		const action = stringArg(request.arguments, "action");
		if (!action) return "Error: 'action' is required.";
		const ids = numberArray(request.arguments.ids);
		const key = projectKey(request);
		if (action === "write") {
			const content = stringArg(request.arguments, "content");
			const category = stringArg(request.arguments, "category");
			if (!content || !category) {
				return "Error: write requires content and category.";
			}
			if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
				return `Error: unsupported memory category ${category}.`;
			}
			const remembered = await this.memory.remember({
				projectKey: key,
				sessionId: request.sessionId,
				observationId: request.requestId,
				observedAtMs: request.invokedAtMs,
				candidates: [
					{
						category: category as MemoryCategory,
						content,
						sourceType: "tool",
					},
				],
			});
			const changed = [...remembered.insertedIds, ...remembered.updatedIds];
			return `Stored memory ${changed.map((id) => `#${id}`).join(", ")}.`;
		}
		if (action === "list") {
			const records = await this.memory.list({
				projectKey: key,
				limit: finite(request.arguments.limit, 10),
				nowMs: request.invokedAtMs,
			});
			return records.length
				? records
						.map(
							(memory) =>
								`#${memory.id} [${memory.category}] importance=${memory.importance} ${memory.content}`,
						)
						.join("\n")
				: "No active memories.";
		}
		if (action === "get") {
			if (ids.length === 0 || ids.length > 20) {
				return "Error: get requires one to twenty ids.";
			}
			const records = await this.memory.get(key, ids);
			const found = new Set(records.map((memory) => memory.id));
			const missing = ids.filter((id) => !found.has(id));
			return [
				...records.map(
					(memory) =>
						`#${memory.id} [${memory.category}] status=${memory.status}\n${memory.content}`,
				),
				...(missing.length
					? [`Missing memory id(s): ${missing.join(", ")}.`]
					: []),
			].join("\n\n");
		}
		if (!(["update", "archive", "merge"] as const).includes(action as never)) {
			return `Error: unsupported memory action ${action}.`;
		}
		const category = stringArg(request.arguments, "category");
		if (
			category &&
			!(MEMORY_CATEGORIES as readonly string[]).includes(category)
		) {
			return `Error: unsupported memory category ${category}.`;
		}
		const mutated = await this.memory.mutate({
			projectKey: key,
			sessionId: request.sessionId,
			requestId: request.requestId,
			action: action as "update" | "archive" | "merge",
			ids,
			nowMs: request.invokedAtMs,
			content: stringArg(request.arguments, "content"),
			category: category as MemoryCategory | undefined,
			reason: stringArg(request.arguments, "reason"),
		});
		return `${action} applied to ${mutated.memories
			.map((memory) => `#${memory.id}`)
			.join(", ")}.`;
	}

	#expand(
		request: ExecuteContextToolRequest,
		state: RuntimeSessionState,
	): string {
		const messages = requestMessages(request, state);
		const ordinal = positiveInteger(request.arguments.message);
		if (ordinal) {
			const found = messages.find((message) => message.ordinal === ordinal);
			if (!found) return `No stored message found at ordinal ${ordinal}.`;
			return `[${found.ordinal}] ${found.role}\n${found.content
				.map(
					(block, index) =>
						`Part ${index + 1} (${block.kind}):\n${canonicalBlockText(block)}`,
				)
				.join("\n\n")}`.slice(0, EXPAND_CHARACTER_BUDGET);
		}
		const start = positiveInteger(request.arguments.start);
		const end = positiveInteger(request.arguments.end);
		if (!start || !end || end < start) {
			return "Error: provide message=<ordinal>, or positive start/end with start <= end.";
		}
		const selected = messages.filter(
			(message) => message.ordinal >= start && message.ordinal <= end,
		);
		if (selected.length === 0) {
			return `No messages found in range ${start}-${end}.`;
		}
		const verbose = request.arguments.verbose === true;
		let output = selected
			.map((message) => {
				const content = messageText(message);
				return verbose
					? `[${message.ordinal}] ${message.role} (${message.content.length} part${message.content.length === 1 ? "" : "s"})\n${content.slice(0, 4_000)}`
					: `[${message.ordinal}] ${roleLabel(message.role)}: ${content.replace(/\s+/g, " ").slice(0, 2_000)}`;
			})
			.join("\n\n");
		if (output.length > EXPAND_CHARACTER_BUDGET) {
			output = `${output.slice(0, EXPAND_CHARACTER_BUDGET)}\n\n[truncated; request a smaller range]`;
		}
		return `Messages ${start}-${end} (${selected.length} messages):\n\n${output}`;
	}

	async #reduce(
		request: ExecuteContextToolRequest,
		state: RuntimeSessionState,
	): Promise<string> {
		const raw = stringArg(request.arguments, "drop");
		if (!raw) return "Error: 'drop' must be provided.";
		let ordinals: number[];
		try {
			ordinals = parseOrdinalRanges(raw);
		} catch (error) {
			return `Error: Invalid range syntax. ${error instanceof Error ? error.message : String(error)}`;
		}
		const messages = requestMessages(request, state);
		const targeted = new Set(ordinals);
		const targetedCallIds = new Set<string>();
		for (const message of messages) {
			if (!targeted.has(message.ordinal)) continue;
			for (const block of message.content) {
				if (
					(block.kind === "tool_call" || block.kind === "tool_result") &&
					block.callId
				) {
					targetedCallIds.add(block.callId);
				}
			}
		}
		if (targetedCallIds.size > 0) {
			for (const message of messages) {
				if (
					message.content.some(
						(block) =>
							(block.kind === "tool_call" || block.kind === "tool_result") &&
							targetedCallIds.has(block.callId),
					)
				) {
					targeted.add(message.ordinal);
				}
			}
			ordinals = [...targeted].sort((left, right) => left - right);
		}
		const known = new Set(messages.map((message) => message.ordinal));
		const unknown = ordinals.filter((ordinal) => !known.has(ordinal));
		if (unknown.length > 0) {
			return `Error: Unknown message ordinal(s): ${unknown.join(", ")}.`;
		}
		const protectedOrdinals = new Set(
			messages
				.filter((message) => message.role === "system")
				.map((message) => message.ordinal),
		);
		for (const message of messages.slice(-3)) {
			protectedOrdinals.add(message.ordinal);
		}
		const unsafe = ordinals.filter((ordinal) => protectedOrdinals.has(ordinal));
		if (unsafe.length > 0) {
			return `Error: Protected current-tail/system ordinal(s): ${unsafe.join(", ")}.`;
		}
		const added = await this.store.updateSession(
			identity(request),
			(current) => {
				const existing = new Set(current.droppedMessageOrdinals);
				const fresh = ordinals.filter((ordinal) => !existing.has(ordinal));
				current.droppedMessageOrdinals = [...existing, ...fresh].sort(
					(left, right) => left - right,
				);
				if (fresh.length > 0) {
					current.revision += 1;
					current.lastCompose = undefined;
				}
				return { state: current, result: fresh };
			},
		);
		return added.length > 0
			? `Queued persistent drop for ${added.map((id) => `§${id}§`).join(", ")}. Raw history remains available through ctx_expand.`
			: "All requested ordinals were already reduced. No new action is needed.";
	}

	async #note(
		request: ExecuteContextToolRequest,
		state: RuntimeSessionState,
	): Promise<string> {
		const action =
			stringArg(request.arguments, "action") ??
			(stringArg(request.arguments, "content") ? "write" : "read");
		if (action === "read") {
			const filter = stringArg(request.arguments, "filter");
			const limit = Math.max(
				1,
				Math.min(100, Math.floor(finite(request.arguments.limit, 25))),
			);
			const offset = Math.max(
				0,
				Math.floor(finite(request.arguments.offset, 0)),
			);
			return this.store.updateSession(identity(request), (current) => {
				const visible = current.notes
					.filter((note) => {
						if (filter === "all") return true;
						if (filter) return note.status === filter;
						return note.status === "active" || note.status === "ready";
					})
					.sort((left, right) => right.createdAtMs - left.createdAtMs)
					.slice(offset, offset + limit);
				for (const note of visible) note.lastReadAtMs = request.invokedAtMs;
				if (visible.length > 0) current.revision += 1;
				return {
					state: current,
					result: visible.length
						? visible
								.map(
									(note) =>
										`- #${note.id} [${note.status}]${note.anchorOrdinal ? ` @msg ${note.anchorOrdinal}` : ""}: ${note.content}${note.surfaceCondition ? `\n  Condition: ${note.surfaceCondition}` : ""}`,
								)
								.join("\n")
						: "No matching notes.",
				};
			});
		}
		if (action === "write") {
			const content = stringArg(request.arguments, "content");
			if (!content) return "Error: write requires content.";
			const condition = stringArg(request.arguments, "surface_condition");
			const anchor = requestMessages(request, state).at(-1)?.ordinal;
			return this.store.updateSession(identity(request), (current) => {
				const note: RuntimeNote = {
					id: current.nextNoteId++,
					type: condition ? "smart" : "session",
					content,
					status: condition ? "pending" : "active",
					surfaceCondition: condition,
					anchorOrdinal: anchor,
					createdAtMs: request.invokedAtMs,
					updatedAtMs: request.invokedAtMs,
				};
				current.notes.push(note);
				current.revision += 1;
				current.lastCompose = undefined;
				return {
					state: current,
					result: `Stored ${note.type} note #${note.id}${condition ? `; it will auto-trigger after ${condition}.` : "."}`,
				};
			});
		}
		const noteId = positiveInteger(request.arguments.note_id);
		if (!noteId) return `Error: ${action} requires note_id.`;
		return this.store.updateSession(identity(request), (current) => {
			const note = current.notes.find((item) => item.id === noteId);
			if (!note)
				return { state: current, result: `Error: Unknown note #${noteId}.` };
			if (action === "dismiss") {
				note.status = "dismissed";
				note.updatedAtMs = request.invokedAtMs;
			} else if (action === "update") {
				const content = stringArg(request.arguments, "content");
				if (!content) {
					return { state: current, result: "Error: update requires content." };
				}
				const condition = stringArg(request.arguments, "surface_condition");
				note.content = content;
				note.surfaceCondition = condition;
				note.type = condition ? "smart" : "session";
				note.status = condition ? "pending" : "active";
				note.readyReason = undefined;
				note.updatedAtMs = request.invokedAtMs;
			} else {
				return {
					state: current,
					result: `Error: unsupported note action ${action}.`,
				};
			}
			current.revision += 1;
			current.lastCompose = undefined;
			return {
				state: current,
				result: `${action} applied to note #${noteId}.`,
			};
		});
	}
}
