import { describe, expect, test } from "bun:test";

import {
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";

import { normalizeRuntimePolicy, resolveRuntimeSchedule } from "./scheduler";
import { emptyRuntimeSessionState } from "./state-store";

function request(inputTokens: number): ComposeContextRequest {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		requestId: "request",
		host: "test",
		sessionId: "session",
		budgetTokens: 1_000,
		capabilities: resolveCapabilities(),
		messages: [],
		usage: { inputTokens, contextLimitTokens: 1_000 },
	};
}

describe("Runtime Scheduler Module", () => {
	test("keeps cache-aware policy and all budget geometry behind one Interface", () => {
		const state = emptyRuntimeSessionState({
			host: "test",
			sessionId: "session",
		});
		state.lastResponseTimeMs = 19_000;
		const schedule = resolveRuntimeSchedule({
			request: request(200),
			state,
			config: normalizeRuntimePolicy(),
			nowMs: 20_000,
			forwardTokens: 250,
			memoryActive: true,
			historyEstimatedTokens: 30,
			injectionTokens: 70,
			unpartitionedInjectionTokens: 20,
			midToolUse: false,
		});

		expect(schedule.decision?.pass).toBe("defer");
		expect(schedule.hardLimitTokens).toBe(1_000);
		expect(schedule.targetTokens).toBe(830);
	});

	test("raises a stale usage observation to the live forward-token floor", () => {
		const state = emptyRuntimeSessionState({
			host: "test",
			sessionId: "session",
		});
		const schedule = resolveRuntimeSchedule({
			request: request(10),
			state,
			config: normalizeRuntimePolicy({ executeThresholdPercentage: 60 }),
			nowMs: 20_000,
			forwardTokens: 800,
			memoryActive: false,
			historyEstimatedTokens: 0,
			injectionTokens: 0,
			unpartitionedInjectionTokens: 0,
			midToolUse: false,
		});

		expect(schedule.decision?.pass).toBe("execute");
		expect(schedule.decision?.pressureExecute).toBe(true);
		// Execute is a scheduling threshold; pressure bands only describe the
		// stronger force/emergency safety states.
		expect(schedule.decision?.pressureBand).toBe("normal");
	});
});
