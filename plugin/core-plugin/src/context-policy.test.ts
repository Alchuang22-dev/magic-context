/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ABSOLUTE_EMERGENCY_PERCENTAGE,
	applyTokenPressureFloor,
	computeTokenPressure,
	decideContextSchedule,
	deriveHistorianChunkTokens,
	derivePressureBand,
	deriveTriggerBudget,
	escalationBands,
	modelKeyLookupOrder,
	parseCacheTtl,
	partitionContextBudget,
	resolveExecuteThreshold,
	resolveExecuteThresholdDetail,
	resolveHistoryBudgetTokens,
} from "./context-policy";

const WARM_SESSION = {
	lastResponseTimeMs: 1_000,
	cacheTtl: "5m",
};

function pressure(
	percentage: number,
	inputTokens = percentage * 1_000,
	hardWallPercentage = percentage,
) {
	return { percentage, inputTokens, hardWallPercentage };
}

describe("execute threshold policy", () => {
	it("resolves exact, host-alias, bare, and progressively shorter model keys", () => {
		expect(
			modelKeyLookupOrder("openai/gpt-5.4-fast", [
				"openai/gpt-5.4-fast",
				"openai-codex/gpt-5.4-fast",
			]),
		).toEqual([
			"openai/gpt-5.4-fast",
			"openai-codex/gpt-5.4-fast",
			"gpt-5.4-fast",
			"openai/gpt-5.4",
			"openai-codex/gpt-5.4",
			"gpt-5.4",
			"openai/gpt",
			"openai-codex/gpt",
			"gpt",
		]);
	});

	it("lets an absolute-token threshold override percentage and reports clamps", () => {
		const detail = resolveExecuteThresholdDetail(
			{ default: 65, "openai/gpt-5.4": 55 },
			"openai/gpt-5.4-fast",
			65,
			{
				tokensConfig: { "openai/gpt-5.4": 190_000 },
				contextLimit: 128_000,
			},
		);

		expect(detail).toEqual({
			percentage: 90,
			mode: "tokens",
			absoluteTokens: 115_200,
			matchedKey: "openai/gpt-5.4",
			clamped: true,
			configuredValue: 190_000,
		});
	});

	it("falls back to the capped percentage policy when token geometry is absent", () => {
		expect(
			resolveExecuteThresholdDetail(95, "some/model", 65, {
				tokensConfig: { "some/model": 10_000 },
			}),
		).toEqual({
			percentage: 90,
			mode: "percentage",
			matchedKey: undefined,
			clamped: true,
			configuredValue: 95,
		});
	});
});

describe("token pressure policy", () => {
	it("counts input and cache tokens but excludes output tokens", () => {
		expect(
			computeTokenPressure(
				{
					inputTokens: 20_000,
					cacheReadTokens: 30_000,
					cacheWriteTokens: 10_000,
					outputTokens: 90_000,
				},
				{ softLimitTokens: 100_000, hardLimitTokens: 200_000 },
			),
		).toEqual({
			inputTokens: 60_000,
			percentage: 60,
			hardWallPercentage: 30,
		});
	});

	it("uses separate soft and hard pressure for force and emergency bands", () => {
		expect(
			derivePressureBand({ percentage: 86, hardWallPercentage: 43 }, 65),
		).toBe("force");
		expect(
			derivePressureBand({ percentage: 70, hardWallPercentage: 95 }, 65),
		).toBe("emergency");
	});

	it("raises stale pressure from a live forward estimate and never lowers it", () => {
		expect(
			applyTokenPressureFloor(
				{ percentage: 68, inputTokens: 273_200 },
				340_000,
				400_000,
				0.85,
			),
		).toEqual({ percentage: 100, inputTokens: 340_000 });
		expect(
			applyTokenPressureFloor(
				{ percentage: 80, inputTokens: 80_000 },
				10_000,
				100_000,
			),
		).toEqual({ percentage: 80, inputTokens: 80_000 });
	});

	it("keeps force above execute while retaining the absolute provider wall", () => {
		expect(escalationBands(65).forceMaterializationPercentage).toBe(85);
		expect(escalationBands(88).forceMaterializationPercentage).toBe(90);
		expect(escalationBands(90).forceMaterializationPercentage).toBe(92);
		expect(escalationBands(90).emergencyPercentage).toBe(
			ABSOLUTE_EMERGENCY_PERCENTAGE,
		);
	});
});

describe("budget partition policy", () => {
	it("partitions usable space, history, memory, working tokens, and headroom", () => {
		expect(
			partitionContextBudget({
				contextLimitTokens: 1_000_000,
				executeThresholdPercentage: 65,
				historyBudgetPercentage: 0.15,
				memoryBudgetTokens: 8_000,
			}),
		).toEqual({
			contextLimitTokens: 1_000_000,
			usableTokens: 650_000,
			reservedHeadroomTokens: 350_000,
			historyTokens: 97_500,
			memoryTokens: 8_000,
			workingTokens: 544_500,
		});
	});

	it("keeps established trigger and historian chunk clamps", () => {
		expect(deriveTriggerBudget(1_000_000, 40)).toBe(20_000);
		expect(deriveTriggerBudget(128_000, 65)).toBe(5_000);
		expect(deriveTriggerBudget(2_000_000, 80)).toBe(50_000);
		expect(deriveTriggerBudget(128_000, 200)).toBe(12_800);
		expect(deriveHistorianChunkTokens(16_000)).toBe(8_000);
		expect(deriveHistorianChunkTokens(128_000)).toBe(32_000);
		expect(deriveHistorianChunkTokens(400_000)).toBe(50_000);
	});

	it("prefers a stable limit and only then back-derives history budget", () => {
		expect(
			resolveHistoryBudgetTokens({
				historyBudgetPercentage: 0.15,
				pressure: { percentage: 0, inputTokens: 0 },
				executeThreshold: 65,
				stableContextLimitTokens: 1_000_000,
			}),
		).toBe(97_500);
		expect(
			resolveHistoryBudgetTokens({
				historyBudgetPercentage: 0.15,
				pressure: { percentage: 40, inputTokens: 200_000 },
				executeThreshold: 65,
			}),
		).toBe(48_750);
	});
});

describe("context scheduling policy", () => {
	it("parses cache TTLs and preserves the strict expiry edge", () => {
		expect(parseCacheTtl("5m")).toBe(300_000);
		expect(parseCacheTtl("30s")).toBe(30_000);
		expect(parseCacheTtl("2h")).toBe(7_200_000);
		expect(parseCacheTtl("1500")).toBe(1_500);
		expect(parseCacheTtl(" never ")).toBe(Number.POSITIVE_INFINITY);
	});

	it("defers a fresh session and executes at the configured pressure", () => {
		const common = {
			config: { executeThresholdPercentage: 65 },
			nowMs: 2_000,
		};
		expect(
			decideContextSchedule({
				...common,
				pressure: pressure(0, 0),
				session: { lastResponseTimeMs: 0, cacheTtl: "5m" },
			}).baseDecision,
		).toBe("defer");
		expect(
			decideContextSchedule({
				...common,
				pressure: pressure(65),
				session: WARM_SESSION,
			}).baseDecision,
		).toBe("execute");
	});

	it("uses default TTL for malformed config and reports that to the adapter", () => {
		const outcome = decideContextSchedule({
			config: { executeThresholdPercentage: 65 },
			pressure: pressure(50),
			session: { lastResponseTimeMs: 1_000, cacheTtl: "bad" },
			nowMs: 301_000,
		});
		expect(outcome.baseDecision).toBe("defer");
		expect(outcome.cacheTtlFallbackUsed).toBe(true);

		const expired = decideContextSchedule({
			config: { executeThresholdPercentage: 65 },
			pressure: pressure(50),
			session: { lastResponseTimeMs: 1_000, cacheTtl: "bad" },
			nowMs: 301_001,
		});
		expect(expired.baseDecision).toBe("execute");
		expect(expired.idleTtlFired).toBe(true);
	});

	it("upgrades pressure bands and defers ordinary execute during open tool use", () => {
		const normal = decideContextSchedule({
			config: { executeThresholdPercentage: 65 },
			pressure: pressure(65),
			session: WARM_SESSION,
			nowMs: 2_000,
			midToolUse: true,
		});
		expect(normal.pass).toBe("defer");
		expect(normal.deferredExecute).toEqual({ reason: "execute-none" });

		const force = decideContextSchedule({
			config: { executeThresholdPercentage: 65 },
			pressure: pressure(85),
			session: WARM_SESSION,
			nowMs: 2_000,
			midToolUse: true,
		});
		expect(force.pass).toBe("force");
		expect(force.drainLatchActiveSinceMs).toBe(2_000);

		const emergency = decideContextSchedule({
			config: { executeThresholdPercentage: 65 },
			pressure: pressure(70, 70_000, 95),
			session: WARM_SESSION,
			nowMs: 2_000,
		});
		expect(emergency.pass).toBe("emergency");
	});
});

describe("Rust scheduler parity", () => {
	type Golden = {
		threshold_cases: Array<{
			label: string;
			percentage_config: number | Record<string, number>;
			tokens_config?: Record<string, number>;
			context_limit?: number;
			model_key?: string;
			fallback: number;
			expected: number;
		}>;
		should_execute_cases: Array<{
			label: string;
			config: {
				execute_threshold_percentage: number | Record<string, number>;
				execute_threshold_tokens?: Record<string, number>;
			};
			session: { last_response_time_ms: number; cache_ttl: string };
			usage: { percentage: number; input_tokens: number };
			now_ms: number;
			context_limit?: number;
			model_key?: string;
			expected: "execute" | "defer";
			expected_threshold: number;
		}>;
	};

	const golden = JSON.parse(
		readFileSync(
			join(import.meta.dir, "../testdata/scheduler-golden.json"),
			"utf8",
		),
	) as Golden;

	it("matches every shared threshold vector", () => {
		for (const testCase of golden.threshold_cases) {
			expect(
				resolveExecuteThreshold(
					testCase.percentage_config,
					testCase.model_key,
					testCase.fallback,
					{
						tokensConfig: testCase.tokens_config,
						contextLimit: testCase.context_limit,
					},
				),
				testCase.label,
			).toBe(testCase.expected);
		}
	});

	it("matches every shared base scheduler vector", () => {
		for (const testCase of golden.should_execute_cases) {
			const outcome = decideContextSchedule({
				config: {
					executeThresholdPercentage:
						testCase.config.execute_threshold_percentage,
					executeThresholdTokens: testCase.config.execute_threshold_tokens,
				},
				pressure: pressure(
					testCase.usage.percentage,
					testCase.usage.input_tokens,
				),
				session: {
					lastResponseTimeMs: testCase.session.last_response_time_ms,
					cacheTtl: testCase.session.cache_ttl,
				},
				nowMs: testCase.now_ms,
				modelKey: testCase.model_key,
				contextLimitTokens: testCase.context_limit,
			});
			expect(outcome.threshold.percentage, testCase.label).toBe(
				testCase.expected_threshold,
			);
			expect(outcome.baseDecision, testCase.label).toBe(testCase.expected);
		}
	});
});
