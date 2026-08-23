import { describe, expect, test } from "bun:test";

import {
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ContextPlan,
	type ContextRuntimeCall,
	InvalidContextPlanError,
	type ObserveTurnRequest,
	resolveCapabilities,
	validateContextPlan,
} from "./protocol";

const request: ComposeContextRequest = {
	protocolVersion: CORE_PROTOCOL_VERSION,
	requestId: "req-1",
	host: "test",
	sessionId: "session-1",
	budgetTokens: 1000,
	capabilities: resolveCapabilities(),
	messages: [
		{
			id: "m1",
			ordinal: 1,
			role: "user",
			content: [{ kind: "text", text: "hello" }],
		},
	],
};

function plan(overrides: Partial<ContextPlan> = {}): ContextPlan {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		requestId: request.requestId,
		decision: "serve",
		retain: { messageIds: ["m1"] },
		mutations: [],
		injections: [],
		accounting: {
			estimatedInputTokens: 10,
			hardLimitTokens: 1000,
			cacheDecision: "hit_safe",
		},
		...overrides,
	};
}

describe("resolveCapabilities", () => {
	test("defaults unsupported optional host capabilities to false", () => {
		expect(resolveCapabilities({ stableMessageIds: true })).toEqual({
			preRequestTransform: true,
			stableMessageIds: true,
			stablePartIds: false,
			usageObservation: false,
			auxiliaryLlm: false,
			toolRegistration: false,
			toolEvents: false,
			requestBlocking: false,
			systemSuffixInjection: false,
			promptCacheFacts: false,
			blockIndexMutations: false,
		});
	});
});

describe("runtime protocol", () => {
	test("represents compose and idempotent turn observation calls", () => {
		const observation: ObserveTurnRequest = {
			protocolVersion: CORE_PROTOCOL_VERSION,
			observationId: "obs-1",
			host: "test",
			sessionId: "session-1",
			observedAtMs: 1_000,
			messages: request.messages,
			outcome: { interrupted: false, failed: false },
			memoryCandidates: [
				{
					category: "PROJECT_RULES",
					content: "Use apply_patch for hand-authored changes.",
					importance: 80,
				},
			],
		};
		const calls: ContextRuntimeCall[] = [
			{ method: "context.compose", params: request },
			{ method: "turn.observe", params: observation },
		];

		expect(calls.map((call) => call.method)).toEqual([
			"context.compose",
			"turn.observe",
		]);
	});
});

describe("validateContextPlan", () => {
	test("accepts a plan that only references the request snapshot", () => {
		expect(validateContextPlan(request, plan())).toEqual(plan());
	});

	test("rejects unknown retained messages", () => {
		expect(() =>
			validateContextPlan(
				request,
				plan({ retain: { messageIds: ["missing"] } }),
			),
		).toThrow(InvalidContextPlanError);
	});

	test("rejects block when the host cannot stop provider dispatch", () => {
		expect(() =>
			validateContextPlan(request, plan({ decision: "block" })),
		).toThrow("host cannot materialize a blocking decision");
	});

	test("rejects duplicate stable injection identities", () => {
		const injection = {
			slot: "stable_prefix" as const,
			content: "history",
			epoch: 1,
			fingerprint: "sha256:one",
		};
		expect(() =>
			validateContextPlan(
				request,
				plan({ injections: [injection, injection] }),
			),
		).toThrow("duplicate injection identity");
	});

	test("validates request-local tag mutations at the adapter seam", () => {
		const tagRequest = {
			...request,
			capabilities: resolveCapabilities({ blockIndexMutations: true }),
		};
		const tagPlan = plan();
		tagPlan.mutations = [
			{
				target: { messageId: "m1", blockIndex: 0 },
				operation: "prefix_tag",
				content: "§7§",
			},
		];

		expect(validateContextPlan(tagRequest, tagPlan)).toBe(tagPlan);
		tagPlan.mutations[0].content = "tag-7";
		expect(() => validateContextPlan(tagRequest, tagPlan)).toThrow(
			"canonical §N§ token",
		);
	});
});
