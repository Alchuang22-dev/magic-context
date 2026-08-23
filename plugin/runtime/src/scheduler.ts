import {
	applyTokenPressureFloor,
	type ComposeContextRequest,
	type ContextScheduleOutcome,
	computeTokenPressure,
	decideContextSchedule,
	partitionContextBudget,
} from "@cortexkit/magic-context-core-plugin";

import type { RuntimeSessionState } from "./state-store";

export interface RuntimePolicyConfig {
	executeThresholdPercentage: number;
	historyBudgetPercentage: number;
	memoryBudgetTokens: number;
	memoryBudgetPercentage: number;
	cacheTtl: string;
	maxObservedTurns: number;
}

export const DEFAULT_RUNTIME_POLICY: Readonly<RuntimePolicyConfig> =
	Object.freeze({
		executeThresholdPercentage: 65,
		historyBudgetPercentage: 0.15,
		memoryBudgetTokens: 8_000,
		memoryBudgetPercentage: 0.1,
		cacheTtl: "5m",
		maxObservedTurns: 32,
	});

export function normalizeRuntimePolicy(
	overrides: Partial<RuntimePolicyConfig> = {},
): RuntimePolicyConfig {
	return {
		executeThresholdPercentage:
			Number.isFinite(overrides.executeThresholdPercentage) &&
			(overrides.executeThresholdPercentage ?? -1) >= 0
				? Number(overrides.executeThresholdPercentage)
				: DEFAULT_RUNTIME_POLICY.executeThresholdPercentage,
		historyBudgetPercentage:
			Number.isFinite(overrides.historyBudgetPercentage) &&
			(overrides.historyBudgetPercentage ?? -1) >= 0 &&
			(overrides.historyBudgetPercentage ?? 2) <= 1
				? Number(overrides.historyBudgetPercentage)
				: DEFAULT_RUNTIME_POLICY.historyBudgetPercentage,
		memoryBudgetTokens:
			Number.isFinite(overrides.memoryBudgetTokens) &&
			(overrides.memoryBudgetTokens ?? -1) >= 0
				? Number(overrides.memoryBudgetTokens)
				: DEFAULT_RUNTIME_POLICY.memoryBudgetTokens,
		memoryBudgetPercentage:
			Number.isFinite(overrides.memoryBudgetPercentage) &&
			(overrides.memoryBudgetPercentage ?? -1) >= 0 &&
			(overrides.memoryBudgetPercentage ?? 2) <= 1
				? Number(overrides.memoryBudgetPercentage)
				: DEFAULT_RUNTIME_POLICY.memoryBudgetPercentage,
		cacheTtl:
			typeof overrides.cacheTtl === "string" && overrides.cacheTtl.length > 0
				? overrides.cacheTtl
				: DEFAULT_RUNTIME_POLICY.cacheTtl,
		maxObservedTurns:
			Number.isInteger(overrides.maxObservedTurns) &&
			(overrides.maxObservedTurns ?? 0) > 0
				? Number(overrides.maxObservedTurns)
				: DEFAULT_RUNTIME_POLICY.maxObservedTurns,
	};
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function observedUsage(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
) {
	return request.usage ?? state.latestUsage ?? {};
}

export function configuredContextLimit(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
): number {
	const observed = observedUsage(request, state);
	return Math.floor(
		finiteNonNegative(request.budgetTokens) ||
			finiteNonNegative(observed.contextLimitTokens),
	);
}

/** Maximum memory allocation before recall is rendered. */
export function deriveMemoryBudgetTokens(
	request: ComposeContextRequest,
	state: RuntimeSessionState,
	config: RuntimePolicyConfig,
): number {
	const contextLimitTokens = configuredContextLimit(request, state);
	if (contextLimitTokens === 0) return 0;
	const percentageCap = Math.floor(
		contextLimitTokens *
			Math.max(0, Math.min(1, config.memoryBudgetPercentage)),
	);
	return partitionContextBudget({
		contextLimitTokens,
		executeThresholdPercentage: config.executeThresholdPercentage,
		historyBudgetPercentage: config.historyBudgetPercentage,
		memoryBudgetTokens: Math.min(config.memoryBudgetTokens, percentageCap),
	}).memoryTokens;
}

export interface RuntimeScheduleRequest {
	request: ComposeContextRequest;
	state: RuntimeSessionState;
	config: RuntimePolicyConfig;
	nowMs: number;
	forwardTokens: number;
	memoryActive: boolean;
	historyEstimatedTokens: number;
	injectionTokens: number;
	/** Trigger/tag tokens not already represented by a budget partition. */
	unpartitionedInjectionTokens: number;
	midToolUse: boolean;
}

export interface RuntimeSchedule {
	contextLimitTokens: number;
	hardLimitTokens: number;
	targetTokens: number;
	decision?: ContextScheduleOutcome;
}

/**
 * Deep Scheduler Module: pressure floors, cache-aware dispatch, budget
 * partitioning, and working-window selection live behind this one Interface.
 */
export function resolveRuntimeSchedule(
	input: RuntimeScheduleRequest,
): RuntimeSchedule {
	const contextLimitTokens = configuredContextLimit(input.request, input.state);
	if (contextLimitTokens === 0) {
		return {
			contextLimitTokens: 0,
			hardLimitTokens: 0,
			targetTokens: Math.max(1, input.forwardTokens),
		};
	}
	const hardLimitTokens = Math.floor(
		contextLimitTokens || Math.max(1, input.forwardTokens),
	);
	const observed = observedUsage(input.request, input.state);
	const observedPressure = computeTokenPressure(observed, {
		softLimitTokens: hardLimitTokens,
		hardLimitTokens,
	});
	const floored = applyTokenPressureFloor(
		observedPressure,
		input.forwardTokens,
		hardLimitTokens,
	);
	const pressureInputTokens = Math.max(
		observedPressure.inputTokens,
		floored.inputTokens,
	);
	const decision = decideContextSchedule({
		config: {
			executeThresholdPercentage: input.config.executeThresholdPercentage,
		},
		pressure: {
			inputTokens: pressureInputTokens,
			percentage: Math.max(observedPressure.percentage, floored.percentage),
			hardWallPercentage: Math.max(
				observedPressure.hardWallPercentage,
				(pressureInputTokens / hardLimitTokens) * 100,
			),
		},
		session: {
			lastResponseTimeMs: input.state.lastResponseTimeMs || input.nowMs,
			cacheTtl: input.config.cacheTtl,
		},
		nowMs: input.nowMs,
		modelKey: input.request.modelKey,
		contextLimitTokens: hardLimitTokens,
		midToolUse: input.midToolUse,
		deferredExecute: input.state.deferredExecute,
		drainLatchActiveSinceMs: input.state.drainLatchActiveSinceMs,
	});
	const partition = partitionContextBudget({
		contextLimitTokens: hardLimitTokens,
		executeThresholdPercentage: decision.threshold.percentage,
		historyBudgetPercentage: input.config.historyBudgetPercentage,
		memoryBudgetTokens: input.memoryActive
			? Math.min(
					input.config.memoryBudgetTokens,
					Math.floor(
						hardLimitTokens *
							Math.max(0, Math.min(1, input.config.memoryBudgetPercentage)),
					),
				)
			: 0,
	});
	const scheduledTarget = Math.max(
		1,
		partition.workingTokens +
			partition.historyTokens -
			input.historyEstimatedTokens -
			input.unpartitionedInjectionTokens,
	);
	const deferredTarget = Math.max(
		1,
		Math.floor(hardLimitTokens * 0.9) - input.injectionTokens,
	);
	return {
		contextLimitTokens,
		hardLimitTokens,
		targetTokens: decision.pass === "defer" ? deferredTarget : scheduledTarget,
		decision,
	};
}
