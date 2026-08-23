import { describe, expect, test } from "bun:test";

import {
	type AgentContextAdapter,
	CORE_PROTOCOL_VERSION,
	type ContextPlan,
	type ContextRuntimeResult,
	type HostCallbackRequest,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";

import { RuntimeAgentController, type RuntimeCaller } from "./controller";

const adapter: AgentContextAdapter<string[]> = {
	host: "test",
	capabilities: resolveCapabilities({ stableMessageIds: true }),
	snapshot(messages) {
		return messages.map((text, index) => ({
			id: `m${index}`,
			ordinal: index + 1,
			role: index % 2 ? "assistant" : "user",
			content: [{ kind: "text", text }],
		}));
	},
	materialize(messages) {
		return [...messages, "materialized"];
	},
};

describe("RuntimeAgentController", () => {
	test("owns reverse callbacks so host adapters only translate LLM execution", async () => {
		const callback: HostCallbackRequest = {
			protocolVersion: CORE_PROTOCOL_VERSION,
			callbackId: "cb",
			kind: "auxiliary_llm",
			host: "test",
			sessionId: "s",
			task: "sidekick",
			taskKey: "sidekick",
			purpose: "test",
			createdAtMs: 1,
			deadlineAtMs: 100,
			attempt: 1,
			request: { mode: "complete", messages: [] },
		};
		let composeCalls = 0;
		let resolutions = 0;
		const runtime: RuntimeCaller = {
			async handle(call): Promise<ContextRuntimeResult> {
				if (call.method === "host.callback.resolve") {
					resolutions += 1;
					return {
						protocolVersion: CORE_PROTOCOL_VERSION,
						resolutionId: "r",
						callbackId: "cb",
						sessionId: "s",
						accepted: true,
						status: "completed",
						revision: 2,
					};
				}
				composeCalls += 1;
				const plan: ContextPlan = {
					protocolVersion: CORE_PROTOCOL_VERSION,
					requestId: (call.params as { requestId: string }).requestId,
					decision: "serve",
					retain: { messageIds: ["m0"] },
					mutations: [],
					injections: [],
					accounting: {
						estimatedInputTokens: 1,
						hardLimitTokens: 100,
						cacheDecision: "hit_safe",
					},
					...(composeCalls === 1 ? { callbacks: [callback] } : {}),
				};
				return plan;
			},
		};
		const controller = new RuntimeAgentController({
			adapter,
			runtime,
			now: () => 10,
			id: (() => {
				let value = 0;
				return () => {
					value += 1;
					return `id-${value}`;
				};
			})(),
			llm: {
				execute: async () => ({ status: "completed", text: "context" }),
			},
		});

		expect(
			await controller.compose(["hello"], {
				sessionId: "s",
				budgetTokens: 100,
			}),
		).toEqual(["hello", "materialized"]);
		expect(composeCalls).toBe(2);
		expect(resolutions).toBe(1);
	});
});
