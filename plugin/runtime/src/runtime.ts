import { homedir } from "node:os";
import { join } from "node:path";

import type {
	ContextPlan,
	ContextRuntimeResult,
	ObserveTurnRequest,
	TurnObservationReceipt,
} from "@cortexkit/magic-context-core-plugin";

import {
	composeContext,
	DEFAULT_RUNTIME_POLICY,
	type RuntimePolicyConfig,
} from "./compose";
import {
	JsonDirectoryRuntimeStateStore,
	type RuntimeSessionIdentity,
	type RuntimeStateStore,
} from "./state-store";
import {
	InvalidRuntimeRequestError,
	validateComposeRequest,
	validateObserveRequest,
} from "./validation";

export interface RuntimeCallEnvelope {
	method: string;
	params: unknown;
}

export interface MagicContextRuntimeOptions {
	store: RuntimeStateStore;
	policy?: Partial<RuntimePolicyConfig>;
	now?: () => number;
}

export class UnknownRuntimeMethodError extends Error {
	readonly code = "METHOD_NOT_FOUND";

	constructor(method: string) {
		super(`unknown runtime method ${method}`);
		this.name = "UnknownRuntimeMethodError";
	}
}

function identity(value: {
	host: string;
	sessionId: string;
}): RuntimeSessionIdentity {
	return { host: value.host, sessionId: value.sessionId };
}

function normalizedPolicy(
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

/** Deep runtime Module behind the two-method agent-plugin Interface. */
export class MagicContextRuntime {
	readonly #store: RuntimeStateStore;
	readonly #policy: RuntimePolicyConfig;
	readonly #now: () => number;

	constructor(options: MagicContextRuntimeOptions) {
		this.#store = options.store;
		this.#policy = normalizedPolicy(options.policy);
		this.#now = options.now ?? Date.now;
	}

	async handle(call: RuntimeCallEnvelope): Promise<ContextRuntimeResult> {
		if (!call || typeof call !== "object") {
			throw new InvalidRuntimeRequestError("runtime call must be an object");
		}
		switch (call.method) {
			case "context.compose":
				return this.#compose(call.params);
			case "turn.observe":
				return this.#observe(call.params);
			default:
				throw new UnknownRuntimeMethodError(String(call.method));
		}
	}

	async #compose(params: unknown): Promise<ContextPlan> {
		const request = validateComposeRequest(params);
		return this.#store.updateSession(identity(request), (state) => {
			if (state.lastCompose?.requestId === request.requestId) {
				return { state, result: state.lastCompose.plan };
			}
			const nowMs = this.#now();
			const composed = composeContext(request, state, this.#policy, nowMs);
			const next = {
				...state,
				revision: state.revision + 1,
				lastComposeAtMs: nowMs,
				drainLatchActiveSinceMs: composed.drainLatchActiveSinceMs,
				deferredExecute: composed.deferredExecute,
				lastCompose: {
					requestId: request.requestId,
					plan: composed.plan,
				},
			};
			return { state: next, result: composed.plan };
		});
	}

	async #observe(params: unknown): Promise<TurnObservationReceipt> {
		const observation = validateObserveRequest(params);
		return this.#store.updateSession(identity(observation), (state) => {
			if (state.recentObservationIds.includes(observation.observationId)) {
				return {
					state,
					result: this.#receipt(observation, false, state.revision),
				};
			}
			const revision = state.revision + 1;
			const { messages, ...observationMetadata } = observation;
			const observations = [
				...state.observations,
				{ ...observationMetadata, messageCount: messages.length },
			].slice(-this.#policy.maxObservedTurns);
			const recentObservationIds = [
				...state.recentObservationIds,
				observation.observationId,
			].slice(-this.#policy.maxObservedTurns * 4);
			const isLatest = observation.observedAtMs >= state.lastResponseTimeMs;
			return {
				state: {
					...state,
					revision,
					lastResponseTimeMs: Math.max(
						state.lastResponseTimeMs,
						observation.observedAtMs,
					),
					latestUsage: isLatest
						? (observation.usage ?? state.latestUsage)
						: state.latestUsage,
					recentObservationIds,
					observations,
					latestObservation: isLatest ? observation : state.latestObservation,
					lastCompose: undefined,
				},
				result: this.#receipt(observation, true, revision),
			};
		});
	}

	#receipt(
		observation: ObserveTurnRequest,
		accepted: boolean,
		revision: number,
	): TurnObservationReceipt {
		return {
			protocolVersion: 1,
			observationId: observation.observationId,
			sessionId: observation.sessionId,
			accepted,
			revision,
			observedAtMs: observation.observedAtMs,
		};
	}
}

function numericEnvironment(
	environment: NodeJS.ProcessEnv,
	name: string,
): number | undefined {
	const raw = environment[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function runtimePolicyFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): Partial<RuntimePolicyConfig> {
	return {
		executeThresholdPercentage: numericEnvironment(
			environment,
			"MAGIC_CONTEXT_EXECUTE_THRESHOLD_PERCENTAGE",
		),
		historyBudgetPercentage: numericEnvironment(
			environment,
			"MAGIC_CONTEXT_HISTORY_BUDGET_PERCENTAGE",
		),
		memoryBudgetTokens: numericEnvironment(
			environment,
			"MAGIC_CONTEXT_MEMORY_BUDGET_TOKENS",
		),
		cacheTtl: environment.MAGIC_CONTEXT_CACHE_TTL,
		maxObservedTurns: numericEnvironment(
			environment,
			"MAGIC_CONTEXT_MAX_OBSERVED_TURNS",
		),
	};
}

export function defaultRuntimeStateDirectory(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	if (environment.MAGIC_CONTEXT_RUNTIME_STATE_DIR?.trim()) {
		return environment.MAGIC_CONTEXT_RUNTIME_STATE_DIR.trim();
	}
	const stateRoot = environment.XDG_STATE_HOME?.trim();
	return stateRoot
		? join(stateRoot, "magic-context", "runtime-v1")
		: join(homedir(), ".local", "state", "magic-context", "runtime-v1");
}

export function createDefaultRuntime(
	environment: NodeJS.ProcessEnv = process.env,
): MagicContextRuntime {
	return new MagicContextRuntime({
		store: new JsonDirectoryRuntimeStateStore(
			defaultRuntimeStateDirectory(environment),
		),
		policy: runtimePolicyFromEnvironment(environment),
	});
}
