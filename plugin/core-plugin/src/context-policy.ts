/**
 * Host-neutral context pressure, budget, and scheduling policy.
 *
 * Hosts own observation and persistence. This module owns the deterministic
 * math and state transitions that must remain identical across adapters.
 */

export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export const MAX_EXECUTE_THRESHOLD_PERCENTAGE = 90;
/** Backward-compatible name used by the existing TypeScript adapters. */
export const MAX_EXECUTE_THRESHOLD = MAX_EXECUTE_THRESHOLD_PERCENTAGE;
export const MIN_FORCE_MATERIALIZATION_PERCENTAGE = 85;
export const ABSOLUTE_EMERGENCY_PERCENTAGE = 95;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
export const EMERGENCY_DRAIN_EXIT_MARGIN = 10;
export const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE = 55;
export const EMERGENCY_DRAIN_MAX_LATCH_MS = 30 * 60 * 1000;

export const TRIGGER_BUDGET_PERCENTAGE = 0.05;
export const TRIGGER_BUDGET_MIN_TOKENS = 5_000;
export const TRIGGER_BUDGET_MAX_TOKENS = 50_000;
export const HISTORIAN_CHUNK_PERCENTAGE = 0.25;
export const HISTORIAN_CHUNK_MIN_TOKENS = 8_000;
export const HISTORIAN_CHUNK_MAX_TOKENS = 50_000;

const TTL_PATTERN = /^(\d+)([smh])$/;
const NUMERIC_PATTERN = /^\d+$/;
const UNIT_TO_MS: Readonly<Record<string, number>> = Object.freeze({
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
});

export type ExecuteThresholdConfig =
	| number
	| { default?: number; [modelKey: string]: number | undefined };

export type ExecuteThresholdTokensConfig = {
	default?: number;
	[modelKey: string]: number | undefined;
};

export type ExecuteThresholdMode = "percentage" | "tokens";

export interface ExecuteThresholdOptions {
	tokensConfig?: ExecuteThresholdTokensConfig;
	contextLimit?: number;
	/**
	 * Adapter-provided equivalent spellings, in precedence order. The core
	 * understands model suffixes but deliberately does not know host aliases.
	 */
	modelLookupKeys?: readonly string[];
}

export interface ExecuteThresholdDetail {
	percentage: number;
	mode: ExecuteThresholdMode;
	absoluteTokens?: number;
	matchedKey?: string;
	clamped?: boolean;
	configuredValue?: number;
}

export interface TokenUsageSample {
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Observed output is carried for completeness but is not pressure input. */
	outputTokens?: number;
}

export interface ContextWindowGeometry {
	/** Output-reserved window used by ordinary scheduling. */
	softLimitTokens: number;
	/** Absolute provider wall. Defaults to the soft limit when unavailable. */
	hardLimitTokens?: number;
}

export interface TokenPressure {
	inputTokens: number;
	percentage: number;
	hardWallPercentage: number;
}

export interface EscalationBands {
	forceMaterializationPercentage: number;
	emergencyPercentage: number;
}

export type PressureBand = "normal" | "force" | "emergency";

export interface ContextBudgetPartition {
	contextLimitTokens: number;
	usableTokens: number;
	reservedHeadroomTokens: number;
	historyTokens: number;
	memoryTokens: number;
	workingTokens: number;
}

export interface ResolveHistoryBudgetInput {
	historyBudgetPercentage: number | undefined;
	pressure: Pick<TokenPressure, "percentage" | "inputTokens">;
	executeThreshold: ExecuteThresholdConfig | undefined;
	modelKey?: string;
	executeThresholdTokens?: ExecuteThresholdTokensConfig;
	stableContextLimitTokens?: number;
	modelLookupKeys?: readonly string[];
}

export type BaseScheduleDecision = "execute" | "defer";
export type ContextSchedulePass = "execute" | "defer" | "force" | "emergency";

export interface ContextSchedulerConfig {
	executeThresholdPercentage: ExecuteThresholdConfig;
	executeThresholdTokens?: ExecuteThresholdTokensConfig;
}

export interface ContextSchedulerSession {
	lastResponseTimeMs: number;
	cacheTtl: string;
}

export interface DeferredExecuteIntent {
	reason: string;
}

export interface ContextScheduleInput {
	config: ContextSchedulerConfig;
	pressure: TokenPressure;
	session: ContextSchedulerSession;
	nowMs: number;
	modelKey?: string;
	modelLookupKeys?: readonly string[];
	contextLimitTokens?: number;
	midToolUse?: boolean;
	explicitBust?: boolean;
	subagent?: boolean;
	deferredExecute?: DeferredExecuteIntent;
	drainLatchActiveSinceMs?: number;
	emergencyRecoveryArmed?: boolean;
}

export interface ContextScheduleOutcome {
	baseDecision: BaseScheduleDecision;
	pass: ContextSchedulePass;
	pressureBand: PressureBand;
	threshold: ExecuteThresholdDetail;
	pressureExecute: boolean;
	idleTtlFired: boolean;
	cacheTtlMs: number;
	cacheTtlFallbackUsed: boolean;
	deferredExecute?: DeferredExecuteIntent;
	drainLatchActiveSinceMs?: number;
}

function isFinitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Yield exact, bare, and progressively less-specific model keys. Provider
 * aliases come from an adapter so the core remains host-neutral.
 */
export function modelKeyLookupOrder(
	modelKey: string,
	modelLookupKeys: readonly string[] = [],
): string[] {
	const refs = unique([...modelLookupKeys, modelKey]);
	const slash = modelKey.indexOf("/");
	let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;
	const candidates: string[] = [];

	while (modelId.length > 0) {
		for (const ref of refs) {
			const refSlash = ref.indexOf("/");
			if (refSlash > 0) {
				candidates.push(`${ref.slice(0, refSlash)}/${modelId}`);
			}
		}
		candidates.push(modelId);
		const lastDash = modelId.lastIndexOf("-");
		if (lastDash <= 0) break;
		modelId = modelId.slice(0, lastDash);
	}

	return unique(candidates);
}

function resolveConfigMatch(
	config: { default?: number; [modelKey: string]: number | undefined },
	modelKey: string | undefined,
	modelLookupKeys: readonly string[] | undefined,
): { value: number; matchedKey: string } | undefined {
	if (modelKey) {
		for (const candidate of modelKeyLookupOrder(modelKey, modelLookupKeys)) {
			const value = config[candidate];
			if (typeof value === "number") {
				return { value, matchedKey: candidate };
			}
		}
	}

	return typeof config.default === "number"
		? { value: config.default, matchedKey: "default" }
		: undefined;
}

/** Resolve percentage and absolute-token thresholds through one deterministic path. */
export function resolveExecuteThresholdDetail(
	config: ExecuteThresholdConfig,
	modelKey: string | undefined,
	fallback: number = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
	options: ExecuteThresholdOptions = {},
): ExecuteThresholdDetail {
	if (options.tokensConfig && isFinitePositive(options.contextLimit)) {
		const match = resolveConfigMatch(
			options.tokensConfig,
			modelKey,
			options.modelLookupKeys,
		);
		if (match && isFinitePositive(match.value)) {
			const cap =
				options.contextLimit * (MAX_EXECUTE_THRESHOLD_PERCENTAGE / 100);
			const effectiveTokens = Math.min(match.value, cap);
			const detail: ExecuteThresholdDetail = {
				percentage: Math.min(
					(effectiveTokens / options.contextLimit) * 100,
					MAX_EXECUTE_THRESHOLD_PERCENTAGE,
				),
				mode: "tokens",
				absoluteTokens: Math.floor(effectiveTokens),
				matchedKey: match.matchedKey,
			};
			if (effectiveTokens < match.value) {
				detail.clamped = true;
				detail.configuredValue = match.value;
			}
			return detail;
		}
	}

	const safeFallback =
		Number.isFinite(fallback) && fallback >= 0
			? fallback
			: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE;
	let resolved: number;
	let matchedKey: string | undefined;
	if (typeof config === "number") {
		resolved = config;
	} else {
		const match = resolveConfigMatch(config, modelKey, options.modelLookupKeys);
		resolved = match?.value ?? safeFallback;
		matchedKey = match?.matchedKey;
	}
	if (!Number.isFinite(resolved) || resolved < 0) {
		resolved = safeFallback;
	}

	const percentage = Math.min(resolved, MAX_EXECUTE_THRESHOLD_PERCENTAGE);
	const detail: ExecuteThresholdDetail = {
		percentage,
		mode: "percentage",
		matchedKey,
	};
	if (percentage < resolved) {
		detail.clamped = true;
		detail.configuredValue = resolved;
	}
	return detail;
}

export function resolveExecuteThreshold(
	config: ExecuteThresholdConfig,
	modelKey: string | undefined,
	fallback: number = DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
	options: ExecuteThresholdOptions = {},
): number {
	return resolveExecuteThresholdDetail(config, modelKey, fallback, options)
		.percentage;
}

/**
 * Compute input-side token pressure. Output tokens are intentionally excluded:
 * they are not part of the cacheable prefix sent with the next request.
 */
export function computeTokenPressure(
	usage: TokenUsageSample,
	geometry: ContextWindowGeometry,
): TokenPressure {
	const inputTokens =
		finiteNonNegative(usage.inputTokens) +
		finiteNonNegative(usage.cacheReadTokens) +
		finiteNonNegative(usage.cacheWriteTokens);
	const percentage = isFinitePositive(geometry.softLimitTokens)
		? (inputTokens / geometry.softLimitTokens) * 100
		: 0;
	const hardLimit = isFinitePositive(geometry.hardLimitTokens)
		? geometry.hardLimitTokens
		: geometry.softLimitTokens;
	const hardWallPercentage = isFinitePositive(hardLimit)
		? (inputTokens / hardLimit) * 100
		: percentage;
	return { inputTokens, percentage, hardWallPercentage };
}

/** Raise a trailing observation with a live forward estimate; never lower it. */
export function applyTokenPressureFloor(
	pressure: Pick<TokenPressure, "percentage" | "inputTokens">,
	forwardInputTokens: number | null | undefined,
	softLimitTokens: number | undefined,
	limitFactor = 1,
): Pick<TokenPressure, "percentage" | "inputTokens"> {
	if (
		!isFinitePositive(forwardInputTokens) ||
		!isFinitePositive(softLimitTokens) ||
		!isFinitePositive(limitFactor)
	) {
		return pressure;
	}
	const forwardPercentage =
		(forwardInputTokens / (softLimitTokens * limitFactor)) * 100;
	return forwardPercentage > pressure.percentage
		? {
				percentage: forwardPercentage,
				inputTokens: Math.max(pressure.inputTokens, forwardInputTokens),
			}
		: pressure;
}

export function escalationBands(
	effectiveThresholdPercentage: number,
): EscalationBands {
	const threshold = Number.isFinite(effectiveThresholdPercentage)
		? Math.min(effectiveThresholdPercentage, MAX_EXECUTE_THRESHOLD_PERCENTAGE)
		: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE;
	return {
		forceMaterializationPercentage: Math.max(
			MIN_FORCE_MATERIALIZATION_PERCENTAGE,
			threshold + 2,
		),
		emergencyPercentage: ABSOLUTE_EMERGENCY_PERCENTAGE,
	};
}

export function derivePressureBand(
	pressure: Pick<TokenPressure, "percentage" | "hardWallPercentage">,
	effectiveThresholdPercentage: number,
): PressureBand {
	const bands = escalationBands(effectiveThresholdPercentage);
	if (pressure.hardWallPercentage >= bands.emergencyPercentage) {
		return "emergency";
	}
	if (pressure.percentage >= bands.forceMaterializationPercentage) {
		return "force";
	}
	return "normal";
}

/** Partition the output-reserved context window into policy-owned token pools. */
export function partitionContextBudget(args: {
	contextLimitTokens: number;
	executeThresholdPercentage: number;
	historyBudgetPercentage?: number;
	memoryBudgetTokens?: number;
}): ContextBudgetPartition {
	const contextLimitTokens = Math.floor(
		finiteNonNegative(args.contextLimitTokens),
	);
	const safeThreshold = Number.isFinite(args.executeThresholdPercentage)
		? Math.max(0, args.executeThresholdPercentage)
		: 0;
	const usableTokens = Math.min(
		contextLimitTokens,
		Math.floor(contextLimitTokens * (safeThreshold / 100)),
	);
	const historyPercentage =
		Number.isFinite(args.historyBudgetPercentage) &&
		(args.historyBudgetPercentage ?? 0) > 0
			? (args.historyBudgetPercentage ?? 0)
			: 0;
	const historyTokens = Math.min(
		usableTokens,
		Math.floor(usableTokens * historyPercentage),
	);
	const memoryTokens = Math.min(
		Math.max(0, usableTokens - historyTokens),
		Math.floor(finiteNonNegative(args.memoryBudgetTokens)),
	);
	return {
		contextLimitTokens,
		usableTokens,
		reservedHeadroomTokens: Math.max(0, contextLimitTokens - usableTokens),
		historyTokens,
		memoryTokens,
		workingTokens: Math.max(0, usableTokens - historyTokens - memoryTokens),
	};
}

export function deriveTriggerBudget(
	mainContextLimit: number,
	executeThresholdPercentage: number,
): number {
	if (!isFinitePositive(mainContextLimit)) {
		return TRIGGER_BUDGET_MIN_TOKENS;
	}
	// Preserve the legacy helper's defensive contract for direct callers: the
	// surrounding max clamp contains thresholds above 100. Normal policy paths
	// resolve the execute threshold to <= 90 before reaching this function.
	const usableTokens =
		mainContextLimit *
		(Math.max(
			0,
			Number.isFinite(executeThresholdPercentage)
				? executeThresholdPercentage
				: 0,
		) /
			100);
	const derived = Math.round(usableTokens * TRIGGER_BUDGET_PERCENTAGE);
	return Math.max(
		TRIGGER_BUDGET_MIN_TOKENS,
		Math.min(TRIGGER_BUDGET_MAX_TOKENS, derived),
	);
}

export function deriveHistorianChunkTokens(
	historianContextLimit: number,
): number {
	if (!isFinitePositive(historianContextLimit)) {
		return HISTORIAN_CHUNK_MIN_TOKENS;
	}
	const derived = Math.round(
		historianContextLimit * HISTORIAN_CHUNK_PERCENTAGE,
	);
	return Math.max(
		HISTORIAN_CHUNK_MIN_TOKENS,
		Math.min(HISTORIAN_CHUNK_MAX_TOKENS, derived),
	);
}

export function resolveHistoryBudgetTokens(
	input: ResolveHistoryBudgetInput,
): number | undefined {
	if (
		!isFinitePositive(input.historyBudgetPercentage) ||
		input.historyBudgetPercentage > 1
	) {
		return undefined;
	}
	let contextLimit = isFinitePositive(input.stableContextLimitTokens)
		? input.stableContextLimitTokens
		: 0;
	if (
		contextLimit === 0 &&
		isFinitePositive(input.pressure.percentage) &&
		isFinitePositive(input.pressure.inputTokens)
	) {
		contextLimit =
			input.pressure.inputTokens / (input.pressure.percentage / 100);
	}
	if (!isFinitePositive(contextLimit)) return undefined;

	const threshold = resolveExecuteThreshold(
		input.executeThreshold ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
		input.modelKey,
		DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
		{
			tokensConfig: input.executeThresholdTokens,
			contextLimit,
			modelLookupKeys: input.modelLookupKeys,
		},
	);
	return partitionContextBudget({
		contextLimitTokens: contextLimit,
		executeThresholdPercentage: threshold,
		historyBudgetPercentage: input.historyBudgetPercentage,
	}).historyTokens;
}

export function parseCacheTtl(ttl: string): number {
	const normalized = ttl.trim();
	if (normalized.toLowerCase() === "never") {
		return Number.POSITIVE_INFINITY;
	}
	if (NUMERIC_PATTERN.test(normalized)) {
		return Number(normalized);
	}
	const match = normalized.match(TTL_PATTERN);
	if (!match) {
		throw new Error(`Invalid cache TTL format: ${ttl}`);
	}
	return Number(match[1]) * UNIT_TO_MS[match[2]];
}

export function isIdleTtlExpired(
	nowMs: number,
	lastResponseTimeMs: number,
	ttlMs: number,
): boolean {
	return Math.max(0, nowMs - lastResponseTimeMs) > ttlMs;
}

export function isHardCacheExpired(
	nowMs: number,
	lastResponseTimeMs: number,
	ttlMs: number,
): boolean {
	return (
		lastResponseTimeMs > 0 && isIdleTtlExpired(nowMs, lastResponseTimeMs, ttlMs)
	);
}

export function emergencyDrainExitThreshold(
	executeThresholdPercentage: number,
): number {
	if (
		!Number.isFinite(executeThresholdPercentage) ||
		executeThresholdPercentage <= 0
	) {
		return EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE;
	}
	return Math.max(0, executeThresholdPercentage - EMERGENCY_DRAIN_EXIT_MARGIN);
}

export function advanceDrainLatch(args: {
	activeSinceMs?: number;
	usagePercentage: number;
	executeThresholdPercentage: number;
	nowMs: number;
}): number | undefined {
	if (
		args.usagePercentage >=
		escalationBands(args.executeThresholdPercentage)
			.forceMaterializationPercentage
	) {
		return args.activeSinceMs ?? args.nowMs;
	}
	if (args.activeSinceMs === undefined) return undefined;
	const expired =
		Math.max(0, args.nowMs - args.activeSinceMs) > EMERGENCY_DRAIN_MAX_LATCH_MS;
	const belowExit =
		args.usagePercentage <
		emergencyDrainExitThreshold(args.executeThresholdPercentage);
	return expired || belowExit ? undefined : args.activeSinceMs;
}

/** Compose threshold, TTL, pressure-band, mid-tool deferral, and drain latch. */
export function decideContextSchedule(
	input: ContextScheduleInput,
): ContextScheduleOutcome {
	const inferredContextLimit = isFinitePositive(input.contextLimitTokens)
		? input.contextLimitTokens
		: isFinitePositive(input.pressure.percentage) &&
				isFinitePositive(input.pressure.inputTokens)
			? input.pressure.inputTokens / (input.pressure.percentage / 100)
			: undefined;
	const threshold = resolveExecuteThresholdDetail(
		input.config.executeThresholdPercentage,
		input.modelKey,
		DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
		{
			tokensConfig: input.config.executeThresholdTokens,
			contextLimit: inferredContextLimit,
			modelLookupKeys: input.modelLookupKeys,
		},
	);

	let cacheTtlMs: number;
	let cacheTtlFallbackUsed = false;
	try {
		cacheTtlMs = parseCacheTtl(input.session.cacheTtl);
	} catch {
		cacheTtlMs = DEFAULT_CACHE_TTL_MS;
		cacheTtlFallbackUsed = true;
	}
	const idleTtlFired = isHardCacheExpired(
		input.nowMs,
		input.session.lastResponseTimeMs,
		cacheTtlMs,
	);
	const freshSession =
		input.pressure.percentage === 0 && input.session.lastResponseTimeMs === 0;
	const pressureExecuteRequested =
		input.pressure.percentage > 0 &&
		input.pressure.percentage >= threshold.percentage;
	const ttlExecuteRequested = isIdleTtlExpired(
		input.nowMs,
		input.session.lastResponseTimeMs,
		cacheTtlMs,
	);
	const baseDecision: BaseScheduleDecision =
		freshSession || (!pressureExecuteRequested && !ttlExecuteRequested)
			? "defer"
			: "execute";

	let pass: ContextSchedulePass =
		baseDecision === "execute" || input.deferredExecute ? "execute" : "defer";
	const pressureBand = derivePressureBand(input.pressure, threshold.percentage);
	if (pressureBand === "emergency") pass = "emergency";
	else if (pressureBand === "force") pass = "force";
	if (input.emergencyRecoveryArmed && pass === "defer") {
		pass = "emergency";
	}

	let deferredExecute = input.deferredExecute;
	const bypassBoundary =
		pass === "force" ||
		pass === "emergency" ||
		input.explicitBust === true ||
		input.subagent === true;
	if (pass !== "defer" && input.midToolUse && !bypassBoundary) {
		pass = "defer";
		deferredExecute ??= { reason: "execute-none" };
	}

	return {
		baseDecision,
		pass,
		pressureBand,
		threshold,
		pressureExecute: pressureExecuteRequested && pass !== "defer",
		idleTtlFired,
		cacheTtlMs,
		cacheTtlFallbackUsed,
		deferredExecute,
		drainLatchActiveSinceMs: advanceDrainLatch({
			activeSinceMs: input.drainLatchActiveSinceMs,
			usagePercentage: input.pressure.percentage,
			executeThresholdPercentage: threshold.percentage,
			nowMs: input.nowMs,
		}),
	};
}
