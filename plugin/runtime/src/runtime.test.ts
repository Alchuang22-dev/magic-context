import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type CanonicalMessage,
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ObserveTurnRequest,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";

import { processRuntimeLine } from "./cli";
import { RuntimeMemory } from "./memory";
import { MemoryRuntimeMemoryStore } from "./memory-store";
import { MagicContextRuntime } from "./runtime";
import {
	JsonDirectoryRuntimeStateStore,
	MemoryRuntimeStateStore,
} from "./state-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function message(
	id: string,
	ordinal: number,
	role: string,
	text: string,
): CanonicalMessage {
	return { id, ordinal, role, content: [{ kind: "text", text }] };
}

function composeRequest(
	messages: CanonicalMessage[],
	overrides: Partial<ComposeContextRequest> = {},
): ComposeContextRequest {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		requestId: "request-1",
		host: "test-host",
		sessionId: "session-1",
		budgetTokens: 1_000,
		capabilities: resolveCapabilities({ usageObservation: true }),
		messages,
		...overrides,
	};
}

function observation(
	overrides: Partial<ObserveTurnRequest> = {},
): ObserveTurnRequest {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		observationId: "observation-1",
		host: "test-host",
		sessionId: "session-1",
		observedAtMs: 10_000,
		messages: [message("user-1", 1, "user", "hello")],
		usage: { inputTokens: 500, outputTokens: 20, contextLimitTokens: 1_000 },
		outcome: { interrupted: false, failed: false },
		...overrides,
	};
}

describe("context.compose", () => {
	test("returns a cache-safe identity plan below the schedule threshold", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 20_000,
		});
		const request = composeRequest([
			message("system", 1, "system", "base"),
			message("user", 2, "user", "hello"),
		]);

		const plan = await runtime.handle({
			method: "context.compose",
			params: request,
		});

		expect("retain" in plan && plan.retain.messageIds).toEqual([
			"system",
			"user",
		]);
		expect("decision" in plan && plan.decision).toBe("defer");
		expect("accounting" in plan && plan.accounting.cacheDecision).toBe(
			"hit_safe",
		);
	});

	test("does not reduce context when the host cannot prove a context limit", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 20_000,
		});
		const request = composeRequest(
			[message("user", 1, "user", "large ".repeat(2_000))],
			{ budgetTokens: 0 },
		);

		const plan = await runtime.handle({
			method: "context.compose",
			params: request,
		});

		if (!("retain" in plan)) throw new Error("expected ContextPlan");
		expect(plan.decision).toBe("defer");
		expect(plan.retain.messageIds).toEqual(["user"]);
		expect(plan.mutations).toEqual([]);
		expect(plan.accounting.hardLimitTokens).toBe(0);
		expect(plan.reason).toBe("unknown-context-limit");
	});

	test("drops old turns but retains a complete recent tool arc", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 20_000,
		});
		const messages: CanonicalMessage[] = [
			message("system", 1, "system", "base"),
			message("old-user", 2, "user", "old ".repeat(1_000)),
			message("old-assistant", 3, "assistant", "old answer"),
			message("new-user", 4, "user", "inspect the file"),
			{
				id: "tool-call",
				ordinal: 5,
				role: "assistant",
				content: [
					{ kind: "tool_call", callId: "call-1", name: "read", input: {} },
				],
			},
			{
				id: "tool-result",
				ordinal: 6,
				role: "tool",
				content: [
					{
						kind: "tool_result",
						callId: "call-1",
						name: "read",
						output: "small result",
					},
				],
			},
		];

		const plan = await runtime.handle({
			method: "context.compose",
			params: composeRequest(messages),
		});

		if (!("retain" in plan)) throw new Error("expected ContextPlan");
		expect(plan.retain.messageIds).toEqual([
			"system",
			"new-user",
			"tool-call",
			"tool-result",
		]);
		expect(plan.retain.protectedTailStart).toBe("new-user");
		expect(plan.accounting.cacheDecision).toBe("bust_required");
	});

	test("fences selection to the invocation side of a cross-turn tool arc", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 20_000,
		});
		const messages: CanonicalMessage[] = [
			message("old-user", 1, "user", "old ".repeat(1_000)),
			{
				id: "call",
				ordinal: 2,
				role: "assistant",
				content: [
					{ kind: "tool_call", callId: "call-1", name: "read", input: {} },
				],
			},
			message("new-user", 3, "user", "continue"),
			{
				id: "result",
				ordinal: 4,
				role: "tool",
				content: [{ kind: "tool_result", callId: "call-1", output: "done" }],
			},
		];

		const plan = await runtime.handle({
			method: "context.compose",
			params: composeRequest(messages),
		});

		if (!("retain" in plan)) throw new Error("expected ContextPlan");
		expect(plan.retain.messageIds).toContain("call");
		expect(plan.retain.messageIds).toContain("result");
	});

	test("bounds an oversized tool result through a host-neutral mutation", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 20_000,
		});
		const messages: CanonicalMessage[] = [
			message("user", 1, "user", "inspect"),
			{
				id: "call",
				ordinal: 2,
				role: "assistant",
				content: [
					{ kind: "tool_call", callId: "call-1", name: "read", input: {} },
				],
			},
			{
				id: "result",
				ordinal: 3,
				role: "tool",
				content: [
					{
						id: "result:block",
						kind: "tool_result",
						callId: "call-1",
						output: "payload".repeat(2_000),
					},
				],
			},
		];

		const plan = await runtime.handle({
			method: "context.compose",
			params: composeRequest(messages, {
				capabilities: resolveCapabilities({
					usageObservation: true,
					stablePartIds: true,
				}),
			}),
		});

		if (!("mutations" in plan)) throw new Error("expected ContextPlan");
		expect(plan.mutations).toHaveLength(1);
		expect(plan.mutations[0].operation).toBe("truncate_tool");
		expect(plan.mutations[0].target.messageId).toBe("result");
		expect(plan.mutations[0].target.blockId).toBe("result:block");
		expect(plan.accounting.estimatedInputTokens).toBeLessThanOrEqual(650);
	});
});

describe("turn.observe", () => {
	test("is idempotent and invalidates the prior compose cache once", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 20_000,
		});
		const request = composeRequest([message("user", 1, "user", "hello")]);
		await runtime.handle({ method: "context.compose", params: request });
		await runtime.handle({ method: "context.compose", params: request });

		const first = await runtime.handle({
			method: "turn.observe",
			params: observation(),
		});
		const duplicate = await runtime.handle({
			method: "turn.observe",
			params: observation(),
		});

		expect("accepted" in first && first.accepted).toBe(true);
		expect("revision" in first && first.revision).toBe(2);
		expect("accepted" in duplicate && duplicate.accepted).toBe(false);
		expect("revision" in duplicate && duplicate.revision).toBe(2);
	});

	test("persists and serializes observations across runtime processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "magic-context-runtime-"));
		temporaryDirectories.push(directory);
		const first = new MagicContextRuntime({
			store: new JsonDirectoryRuntimeStateStore(directory),
		});
		const second = new MagicContextRuntime({
			store: new JsonDirectoryRuntimeStateStore(directory),
		});

		const [one, two] = await Promise.all([
			first.handle({ method: "turn.observe", params: observation() }),
			second.handle({
				method: "turn.observe",
				params: observation({
					observationId: "observation-2",
					observedAtMs: 20_000,
				}),
			}),
		]);
		const duplicate = await first.handle({
			method: "turn.observe",
			params: observation(),
		});

		expect(
			[one, two]
				.map((receipt) => ("revision" in receipt ? receipt.revision : -1))
				.sort(),
		).toEqual([1, 2]);
		expect("accepted" in duplicate && duplicate.accepted).toBe(false);
		expect("revision" in duplicate && duplicate.revision).toBe(2);
	});

	test("does not let a delayed observation replace newer usage", async () => {
		const store = new MemoryRuntimeStateStore();
		const runtime = new MagicContextRuntime({ store });
		await runtime.handle({
			method: "turn.observe",
			params: observation({
				observationId: "newer",
				observedAtMs: 20_000,
				usage: { inputTokens: 800, contextLimitTokens: 1_000 },
			}),
		});
		await runtime.handle({
			method: "turn.observe",
			params: observation({
				observationId: "older",
				observedAtMs: 10_000,
				usage: { inputTokens: 10, contextLimitTokens: 1_000 },
			}),
		});

		const state = await store.updateSession(
			{ host: "test-host", sessionId: "session-1" },
			(current) => ({ state: current, result: current }),
		);
		expect(state.latestUsage?.inputTokens).toBe(800);
		expect(state.latestObservation?.observationId).toBe("newer");
		const latestRecord = state.observations.at(-1);
		expect(latestRecord?.messageCount).toBe(1);
		expect(latestRecord?.memoryCandidateCount).toBe(0);
		if (!latestRecord) throw new Error("expected observation metadata");
		expect("messages" in latestRecord).toBe(false);
	});

	test("stores observed memory candidates and recalls them across sessions", async () => {
		const memoryStore = new MemoryRuntimeMemoryStore();
		const memory = new RuntimeMemory(memoryStore);
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			memory,
			now: () => 20_000,
		});
		const observed = observation({
			projectId: "project-a",
			memoryCandidates: [
				{
					category: "PROJECT_RULES",
					content: "Use Bun for package scripts and tests.",
					importance: 80,
				},
			],
		});

		await runtime.handle({ method: "turn.observe", params: observed });
		await runtime.handle({ method: "turn.observe", params: observed });
		const first = await runtime.handle({
			method: "context.compose",
			params: composeRequest(
				[message("user", 1, "user", "Which package scripts should I use?")],
				{
					requestId: "recall-1",
					sessionId: "session-2",
					projectId: "project-a",
					budgetTokens: 4_000,
					capabilities: resolveCapabilities({
						systemSuffixInjection: true,
					}),
				},
			),
		});
		const second = await runtime.handle({
			method: "context.compose",
			params: composeRequest(
				[message("user", 1, "user", "Which package scripts should I use?")],
				{
					requestId: "recall-2",
					sessionId: "session-2",
					projectId: "project-a",
					budgetTokens: 4_000,
					capabilities: resolveCapabilities({
						systemSuffixInjection: true,
					}),
				},
			),
		});

		if (!("injections" in first) || !("injections" in second)) {
			throw new Error("expected ContextPlan");
		}
		expect(first.injections).toHaveLength(1);
		expect(first.injections[0].slot).toBe("stable_prefix");
		expect(String(first.injections[0].content)).toContain(
			"Use Bun for package scripts and tests.",
		);
		expect(first.accounting.cacheDecision).toBe("bust_required");
		expect(second.accounting.cacheDecision).toBe("hit_safe");
		const stored = await memoryStore.readProject("project-a");
		expect(stored.memories).toHaveLength(1);
		expect(stored.memories[0].seenCount).toBe(1);
	});

	test("rejects malformed memory candidates at the runtime Interface", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
		});
		const response = JSON.parse(
			await processRuntimeLine(
				runtime,
				JSON.stringify({
					method: "turn.observe",
					params: observation({
						memoryCandidates: [
							{ category: "SECRETS", content: "do not store" },
						] as never,
					}),
				}),
			),
		);

		expect(response.error.code).toBe("INVALID_REQUEST");
		expect(response.error.message).toContain("category is unsupported");
	});
});

describe("stdio Interface", () => {
	test("returns structured method and validation errors", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
		});
		const unknown = JSON.parse(
			await processRuntimeLine(
				runtime,
				JSON.stringify({ method: "missing", params: {} }),
			),
		);
		const malformed = JSON.parse(await processRuntimeLine(runtime, "not-json"));

		expect(unknown.error.code).toBe("METHOD_NOT_FOUND");
		expect(malformed.error.code).toBe("RUNTIME_ERROR");
	});

	test("rejects canonical blocks whose token cost cannot be interpreted", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
		});
		const request = composeRequest([
			{
				id: "bad",
				ordinal: 1,
				role: "user",
				content: [{ kind: "unknown-extension" } as never],
			},
		]);
		const response = JSON.parse(
			await processRuntimeLine(
				runtime,
				JSON.stringify({ method: "context.compose", params: request }),
			),
		);

		expect(response.error.code).toBe("INVALID_REQUEST");
		expect(response.error.message).toContain("kind is unsupported");
	});

	test("serves an actual NDJSON stdio process", async () => {
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "cli.ts"), "--memory"],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		child.stdin.write(
			`${JSON.stringify({
				method: "turn.observe",
				params: observation(),
			})}\n`,
		);
		child.stdin.end();
		const output = await new Response(child.stdout).text();
		const errorOutput = await new Response(child.stderr).text();
		const exitCode = await child.exited;

		expect(exitCode, errorOutput).toBe(0);
		const response = JSON.parse(output.trim());
		expect(response.result.accepted).toBe(true);
		expect(response.result.observationId).toBe("observation-1");
	});

	test("recalls durable memory across separate one-shot processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "magic-context-runtime-"));
		temporaryDirectories.push(directory);
		const invoke = async (call: unknown) => {
			const child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "cli.ts"),
					"--state-dir",
					directory,
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			child.stdin.write(`${JSON.stringify(call)}\n`);
			child.stdin.end();
			const output = await new Response(child.stdout).text();
			const errorOutput = await new Response(child.stderr).text();
			expect(await child.exited, errorOutput).toBe(0);
			return JSON.parse(output.trim());
		};

		await invoke({
			method: "turn.observe",
			params: observation({
				projectId: "project-persisted",
				memoryCandidates: [
					{
						category: "ARCHITECTURE",
						content: "The runtime owns durable memory recall.",
					},
				],
			}),
		});
		const response = await invoke({
			method: "context.compose",
			params: composeRequest(
				[message("user", 1, "user", "Who owns memory recall?")],
				{
					requestId: "separate-process-compose",
					projectId: "project-persisted",
					budgetTokens: 4_000,
					capabilities: resolveCapabilities({
						systemSuffixInjection: true,
					}),
				},
			),
		});

		expect(response.result.injections).toHaveLength(1);
		expect(response.result.injections[0].content).toContain(
			"runtime owns durable memory recall",
		);
	});
});
