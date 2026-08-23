import { describe, expect, test } from "bun:test";

import {
	type AuxiliaryRuntimePolicy,
	type CanonicalMessage,
	CORE_PROTOCOL_VERSION,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";

import { validateHistorianOutput } from "./auxiliary";
import { RuntimeMemory } from "./memory";
import { MemoryRuntimeMemoryStore } from "./memory-store";
import { MagicContextRuntime } from "./runtime";
import { MemoryRuntimeStateStore } from "./state-store";

function message(
	ordinal: number,
	role: string,
	text: string,
): CanonicalMessage {
	return {
		id: `message-${ordinal}`,
		ordinal,
		role,
		content: [{ id: `block-${ordinal}`, kind: "text", text }],
	};
}

const POLICY: AuxiliaryRuntimePolicy = {
	historianEnabled: true,
	historianThresholdPercentage: 0,
	historianMinMessages: 4,
	historianProtectedTailMessages: 2,
	historianTimeoutMs: 1_000,
	dreamerEnabled: true,
	dreamerIntervalMs: 0,
	dreamerTimeoutMs: 1_000,
	sidekickEnabled: false,
	sidekickTimeoutMs: 1_000,
	maxAttempts: 3,
};

async function start(
	runtime: MagicContextRuntime,
	policy: AuxiliaryRuntimePolicy = POLICY,
) {
	return runtime.handle({
		method: "session.lifecycle",
		params: {
			protocolVersion: CORE_PROTOCOL_VERSION,
			eventId: "start-1",
			host: "hermes",
			sessionId: "session-a",
			action: "start",
			observedAtMs: 1_000,
			projectId: "project-a",
			auxiliaryPolicy: policy,
		},
	});
}

function transcript(): CanonicalMessage[] {
	return [
		message(1, "system", "system"),
		...Array.from({ length: 9 }, (_, index) =>
			message(
				index + 2,
				index % 2 === 0 ? "user" : "assistant",
				`turn ${index + 2}`,
			),
		),
	];
}

function observe(messages: CanonicalMessage[]) {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		observationId: "observation-1",
		host: "hermes",
		sessionId: "session-a",
		projectId: "project-a",
		observedAtMs: 1_000,
		messages,
		usage: { inputTokens: 800, contextLimitTokens: 1_000 },
		outcome: { interrupted: false, failed: false },
	};
}

function resolution(callback: Record<string, unknown>, parsed: unknown) {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		resolutionId: `resolution-${String(callback.attempt)}`,
		host: "hermes",
		sessionId: "session-a",
		callbackId: callback.callbackId,
		attempt: callback.attempt,
		resolvedAtMs: 1_100,
		outcome: {
			status: "completed",
			text: JSON.stringify(parsed),
			parsed,
			provider: "test",
			model: "test-model",
		},
	};
}

describe("auxiliary execution chain", () => {
	test("validates and persists Historian output before scheduling Dreamer", async () => {
		let nowMs = 1_000;
		const store = new MemoryRuntimeStateStore();
		const memoryStore = new MemoryRuntimeMemoryStore();
		const runtime = new MagicContextRuntime({
			store,
			memory: new RuntimeMemory(memoryStore),
			now: () => nowMs,
		});
		await start(runtime);
		const messages = transcript();
		const observed = await runtime.handle({
			method: "turn.observe",
			params: observe(messages),
		});
		if (!("callbacks" in observed) || !observed.callbacks?.[0]) {
			throw new Error("expected Historian callback");
		}
		const historian = observed.callbacks[0];
		expect(historian.task).toBe("historian");
		expect(historian.taskKey).toBe("magic_context_historian");

		const historianOutput = {
			compartments: [
				{
					startOrdinal: 2,
					endOrdinal: 8,
					title: "Migration implementation",
					episodeType: "implementation",
					importance: 90,
					p1: "Full migration discussion and decisions.",
					p2: "The runtime owns callback validation and persistence.",
					p3: "Runtime owns auxiliary state.",
					p4: "Runtime-owned callbacks.",
				},
			],
			memoryCandidates: [
				{
					category: "ARCHITECTURE",
					content:
						"The runtime owns auxiliary callback validation and persistence.",
					importance: 90,
				},
			],
		};
		nowMs = 1_100;
		const historianReceipt = await runtime.handle({
			method: "host.callback.resolve",
			params: resolution(
				historian as unknown as Record<string, unknown>,
				historianOutput,
			),
		});
		if (
			!("callbacks" in historianReceipt) ||
			!historianReceipt.callbacks?.[0]
		) {
			throw new Error("expected Dreamer callback");
		}
		expect(historianReceipt.callbacks[0].task).toBe("dreamer");

		const state = await store.readSession({
			host: "hermes",
			sessionId: "session-a",
		});
		expect(state.auxiliary.historianCursorOrdinal).toBe(8);
		expect(state.droppedMessageOrdinals).toEqual([2, 3, 4, 5, 6, 7, 8]);
		expect(state.auxiliary.compartments).toHaveLength(1);
		const project = await memoryStore.readProject("project-a");
		expect(project.memories[0].content).toContain("callback validation");

		const plan = await runtime.handle({
			method: "context.compose",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: "compose-history",
				host: "hermes",
				sessionId: "session-a",
				projectId: "project-a",
				budgetTokens: 4_000,
				capabilities: resolveCapabilities({
					stablePartIds: true,
					systemSuffixInjection: true,
					auxiliaryLlm: true,
				}),
				messages,
			},
		});
		if (!("injections" in plan)) throw new Error("expected ContextPlan");
		expect(String(plan.injections[0]?.content)).toContain("<session-history>");
		expect(plan.mutations).toContainEqual({
			target: { messageId: "message-2" },
			operation: "drop",
		});

		const dreamer = historianReceipt.callbacks[0];
		const dreamerReceipt = await runtime.handle({
			method: "host.callback.resolve",
			params: resolution(dreamer as unknown as Record<string, unknown>, {
				memoryCandidates: [],
				archiveIds: [],
				summary: "No changes required.",
			}),
		});
		expect("status" in dreamerReceipt && dreamerReceipt.status).toBe(
			"completed",
		);
	});

	test("retries invalid output, recovers an expired lease, and fences late attempts", async () => {
		let nowMs = 1_000;
		const store = new MemoryRuntimeStateStore();
		const runtime = new MagicContextRuntime({ store, now: () => nowMs });
		await start(runtime, { ...POLICY, dreamerEnabled: false, maxAttempts: 2 });
		const observed = await runtime.handle({
			method: "turn.observe",
			params: observe(transcript()),
		});
		if (!("callbacks" in observed) || !observed.callbacks?.[0]) {
			throw new Error("expected callback");
		}
		const first = observed.callbacks[0];
		const rejected = await runtime.handle({
			method: "host.callback.resolve",
			params: resolution(first as unknown as Record<string, unknown>, {
				compartments: [],
				memoryCandidates: [],
			}),
		});
		expect("status" in rejected && rejected.status).toBe("retry_scheduled");

		nowMs = 2_000;
		const poll = await runtime.handle({
			method: "maintenance.poll",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				pollId: "poll-retry",
				host: "hermes",
				sessionId: "session-a",
				polledAtMs: nowMs,
				tasks: ["historian"],
			},
		});
		if (!("callbacks" in poll) || !poll.callbacks[0]) {
			throw new Error("expected retry callback");
		}
		expect(poll.callbacks[0].attempt).toBe(2);

		const late = await runtime.handle({
			method: "host.callback.resolve",
			params: {
				...resolution(first as unknown as Record<string, unknown>, {}),
				resolutionId: "late-attempt-one",
			},
		});
		expect("accepted" in late && late.accepted).toBe(false);

		nowMs = 3_001;
		const exhausted = await runtime.handle({
			method: "maintenance.poll",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				pollId: "poll-expired",
				host: "hermes",
				sessionId: "session-a",
				polledAtMs: nowMs,
				tasks: ["historian"],
			},
		});
		expect("callbacks" in exhausted && exhausted.callbacks).toEqual([]);
		const state = await store.readSession({
			host: "hermes",
			sessionId: "session-a",
		});
		expect(state.auxiliary.jobs[0].status).toBe("failed");
		expect(state.auxiliary.historianCursorOrdinal).toBe(0);
		expect(state.droppedMessageOrdinals).toEqual([]);
	});

	test("runs Sidekick before compose and injects its useful callback result", async () => {
		const runtime = new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			now: () => 2_000,
		});
		await start(runtime, {
			...POLICY,
			historianEnabled: false,
			dreamerEnabled: false,
			sidekickEnabled: true,
		});
		await runtime.handle({
			method: "tool.execute",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: "memory-write",
				host: "hermes",
				sessionId: "session-a",
				projectId: "project-a",
				toolName: "ctx_memory",
				arguments: {
					action: "write",
					category: "PROJECT_RULES",
					content: "Always run the Bun verification suite.",
				},
				invokedAtMs: 1_500,
				messages: [message(1, "user", "remember verification")],
			},
		});
		const composeParams = {
			protocolVersion: CORE_PROTOCOL_VERSION,
			requestId: "sidekick-compose-1",
			host: "hermes",
			sessionId: "session-a",
			projectId: "project-a",
			budgetTokens: 4_000,
			capabilities: resolveCapabilities({
				auxiliaryLlm: true,
				systemSuffixInjection: true,
			}),
			messages: [
				message(1, "user", "Which verification suite should I run now?"),
			],
		};
		const firstPlan = await runtime.handle({
			method: "context.compose",
			params: composeParams,
		});
		if (!("callbacks" in firstPlan) || !firstPlan.callbacks?.[0]) {
			throw new Error("expected Sidekick callback");
		}
		expect(firstPlan.callbacks[0].task).toBe("sidekick");
		const callback = firstPlan.callbacks[0];
		await runtime.handle({
			method: "host.callback.resolve",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				resolutionId: "sidekick-resolution",
				host: "hermes",
				sessionId: "session-a",
				callbackId: callback.callbackId,
				attempt: callback.attempt,
				resolvedAtMs: 2_100,
				outcome: {
					status: "completed",
					text: "<think>selecting</think>Run the Bun verification suite.",
				},
			},
		});
		const secondPlan = await runtime.handle({
			method: "context.compose",
			params: {
				...composeParams,
				requestId: "sidekick-compose-2",
			},
		});
		if (!("injections" in secondPlan)) throw new Error("expected ContextPlan");
		expect(
			secondPlan.injections.some((injection) =>
				String(injection.content).includes("Run the Bun verification suite."),
			),
		).toBe(true);
		expect(JSON.stringify(secondPlan.injections)).not.toContain("selecting");
	});

	test("rejects Historian compartments with gaps", () => {
		expect(() =>
			validateHistorianOutput(
				{
					compartments: [
						{
							startOrdinal: 2,
							endOrdinal: 3,
							title: "one",
							episodeType: "work",
							importance: 50,
							p1: "one",
							p2: "one",
							p3: "one",
							p4: "one",
						},
						{
							startOrdinal: 5,
							endOrdinal: 6,
							title: "two",
							episodeType: "work",
							importance: 50,
							p1: "two",
							p2: "two",
							p3: "two",
							p4: "two",
						},
					],
					memoryCandidates: [],
				},
				"",
				[2, 3, 4, 5, 6],
			),
		).toThrow("ordered and contiguous");
	});
});
