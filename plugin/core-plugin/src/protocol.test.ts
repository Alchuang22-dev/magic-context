import { describe, expect, test } from "bun:test";

import {
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	type ContextPlan,
	InvalidContextPlanError,
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
		});
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
});
