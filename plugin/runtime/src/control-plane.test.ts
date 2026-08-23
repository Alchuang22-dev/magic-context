import { describe, expect, test } from "bun:test";

import {
	type CanonicalMessage,
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ExecuteContextToolRequest,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";

import { RuntimeMemory } from "./memory";
import { MemoryRuntimeMemoryStore } from "./memory-store";
import { MagicContextRuntime } from "./runtime";
import { MemoryRuntimeStateStore } from "./state-store";

function message(
	id: string,
	ordinal: number,
	role: string,
	text: string,
): CanonicalMessage {
	return {
		id,
		ordinal,
		role,
		content: [{ id: `${id}:text`, kind: "text", text }],
	};
}

function toolRequest(
	toolName: ExecuteContextToolRequest["toolName"],
	requestId: string,
	args: Record<string, unknown>,
	messages: CanonicalMessage[],
	overrides: Partial<ExecuteContextToolRequest> = {},
): ExecuteContextToolRequest {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		requestId,
		host: "hermes",
		sessionId: "session-a",
		projectId: "project-a",
		toolName,
		arguments: args,
		messages,
		invokedAtMs: 10_000,
		...overrides,
	};
}

function runtimeFixture() {
	const store = new MemoryRuntimeStateStore();
	const runtime = new MagicContextRuntime({
		store,
		memory: new RuntimeMemory(new MemoryRuntimeMemoryStore()),
		now: () => 20_000,
	});
	return { runtime, store };
}

describe("runtime control plane", () => {
	test("provides memory write/get/search and raw message expand", async () => {
		const { runtime } = runtimeFixture();
		const messages = [
			message("old-user", 1, "user", "We selected the lunar naming rule."),
			message("old-assistant", 2, "assistant", "Use lunar names for queues."),
			message("new-user", 3, "user", "continue"),
		];

		const write = await runtime.handle({
			method: "tool.execute",
			params: toolRequest(
				"ctx_memory",
				"memory-write",
				{
					action: "write",
					category: "NAMING",
					content: "Queue names must use lunar terms.",
				},
				messages,
			),
		});
		expect("output" in write && write.output).toContain("#1");

		const search = await runtime.handle({
			method: "tool.execute",
			params: toolRequest(
				"ctx_search",
				"search",
				{ query: "lunar naming", sources: ["memory", "message"] },
				messages,
			),
		});
		expect("output" in search && search.output).toContain("[memory]");
		expect("output" in search && search.output).toContain("ordinal=1");

		const expand = await runtime.handle({
			method: "tool.execute",
			params: toolRequest("ctx_expand", "expand", { message: 2 }, messages),
		});
		expect("output" in expand && expand.output).toContain(
			"Use lunar names for queues.",
		);
	});

	test("persists reductions while keeping raw messages expandable", async () => {
		const { runtime } = runtimeFixture();
		const messages = [
			message("old-user", 1, "user", "old question"),
			message("old-answer", 2, "assistant", "old answer"),
			message("current-user", 3, "user", "current question"),
			message("current-answer", 4, "assistant", "working"),
			message("latest-user", 5, "user", "latest"),
		];
		const capabilities = resolveCapabilities({
			stablePartIds: true,
			blockIndexMutations: true,
			systemSuffixInjection: true,
		});
		await runtime.handle({
			method: "context.compose",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: "compose-before-reduce",
				host: "hermes",
				sessionId: "session-a",
				projectId: "project-a",
				budgetTokens: 4_000,
				capabilities,
				messages,
			},
		});
		const reduced = await runtime.handle({
			method: "tool.execute",
			params: toolRequest(
				"ctx_reduce",
				"reduce",
				{ drop: "§1§,§2§" },
				messages,
			),
		});
		expect("output" in reduced && reduced.output).toContain("§1§, §2§");

		const compose: ComposeContextRequest = {
			protocolVersion: CORE_PROTOCOL_VERSION,
			requestId: "compose-after-reduce",
			host: "hermes",
			sessionId: "session-a",
			projectId: "project-a",
			budgetTokens: 4_000,
			capabilities,
			messages,
		};
		const plan = await runtime.handle({
			method: "context.compose",
			params: compose,
		});
		if (!("mutations" in plan)) throw new Error("expected plan");
		expect(plan.mutations).toEqual(
			expect.arrayContaining([
				{
					target: { messageId: "old-user", blockId: "old-user:text" },
					operation: "drop",
				},
				{
					target: {
						messageId: "old-answer",
						blockId: "old-answer:text",
					},
					operation: "drop",
				},
			]),
		);

		const expanded = await runtime.handle({
			method: "tool.execute",
			params: toolRequest(
				"ctx_expand",
				"expand-after-reduce",
				{ tag: 1 },
				messages,
			),
		});
		expect("output" in expanded && expanded.output).toContain("§1§");
		expect("output" in expanded && expanded.output).toContain("old question");
	});

	test("turns tool-conditioned notes and large outputs into compose triggers", async () => {
		const { runtime } = runtimeFixture();
		const messages = [message("user", 1, "user", "watch the read tool")];
		const note = await runtime.handle({
			method: "tool.execute",
			params: toolRequest(
				"ctx_note",
				"note-write",
				{
					action: "write",
					content: "Review the generated manifest.",
					surface_condition: "tool:read_file",
				},
				messages,
			),
		});
		expect("output" in note && note.output).toContain("note #1");

		const event = await runtime.handle({
			method: "tool.observe",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: "tool-event-1",
				host: "hermes",
				sessionId: "session-a",
				observedAtMs: 11_000,
				phase: "post",
				toolName: "read_file",
				status: "ok",
				result: "x".repeat(9_000),
			},
		});
		expect("triggersQueued" in event && event.triggersQueued).toBe(2);

		const plan = await runtime.handle({
			method: "context.compose",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: "trigger-compose",
				host: "hermes",
				sessionId: "session-a",
				projectId: "project-a",
				budgetTokens: 4_000,
				capabilities: resolveCapabilities({ systemSuffixInjection: true }),
				messages,
			},
		});
		if (!("injections" in plan)) throw new Error("expected plan");
		const nudge = plan.injections.find((item) => item.slot === "tail_nudge");
		expect(String(nudge?.content)).toContain("Smart note #1 is ready");
		expect(String(nudge?.content)).toContain("returned 9002 characters");
	});

	test("supports clone, reset, delete, and idempotent cache feedback", async () => {
		const { runtime, store } = runtimeFixture();
		const messages = [message("user", 1, "user", "keep this note")];
		await runtime.handle({
			method: "tool.execute",
			params: toolRequest(
				"ctx_note",
				"note-before-clone",
				{ action: "write", content: "clone me" },
				messages,
			),
		});
		const clone = await runtime.handle({
			method: "session.lifecycle",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: "clone-1",
				host: "hermes",
				sessionId: "session-a",
				targetSessionId: "session-b",
				action: "clone",
				observedAtMs: 12_000,
			},
		});
		expect("accepted" in clone && clone.accepted).toBe(true);

		const clonedRead = await runtime.handle({
			method: "tool.execute",
			params: toolRequest("ctx_note", "read-clone", { action: "read" }, [], {
				sessionId: "session-b",
			}),
		});
		expect("output" in clonedRead && clonedRead.output).toContain("clone me");

		const feedback = {
			protocolVersion: CORE_PROTOCOL_VERSION,
			eventId: "cache-1",
			host: "hermes",
			sessionId: "session-b",
			observedAtMs: 13_000,
			usage: {
				inputTokens: 700,
				cacheReadTokens: 100,
				cacheWriteTokens: 100,
				contextLimitTokens: 1_000,
			},
		};
		const first = await runtime.handle({
			method: "cache.observe",
			params: feedback,
		});
		const duplicate = await runtime.handle({
			method: "cache.observe",
			params: feedback,
		});
		expect("accepted" in first && first.accepted).toBe(true);
		expect("accepted" in duplicate && duplicate.accepted).toBe(false);

		const reset = await runtime.handle({
			method: "session.lifecycle",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: "reset-1",
				host: "hermes",
				sessionId: "session-b",
				action: "reset",
				observedAtMs: 14_000,
			},
		});
		expect("accepted" in reset && reset.accepted).toBe(true);
		expect(
			(await store.readSession({ host: "hermes", sessionId: "session-b" }))
				.notes,
		).toEqual([]);

		const deleted = await runtime.handle({
			method: "session.lifecycle",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: "delete-1",
				host: "hermes",
				sessionId: "session-b",
				action: "delete",
				observedAtMs: 15_000,
			},
		});
		expect("accepted" in deleted && deleted.accepted).toBe(true);
		expect(
			(await store.readSession({ host: "hermes", sessionId: "session-b" }))
				.revision,
		).toBe(0);
	});
});
