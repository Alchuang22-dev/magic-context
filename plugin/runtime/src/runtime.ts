import { homedir } from "node:os";
import { join } from "node:path";

import type {
	ContextPlan,
	ContextRuntimeResult,
	ObserveTurnRequest,
	TurnObservationReceipt,
} from "@cortexkit/magic-context-core-plugin";

import { RuntimeAuxiliaryCoordinator } from "./auxiliary";
import { composeContext } from "./compose";
import { RuntimeControlPlane } from "./control-plane";
import { RuntimeInjection } from "./injection";
import { memoryProjectKey, type RuntimeMemory } from "./memory";
import { normalizeRuntimePolicy, type RuntimePolicyConfig } from "./scheduler";
import type { RuntimeSessionIdentity, RuntimeStateStore } from "./state-store";
import { RuntimeStorage } from "./storage";
import { RuntimeTagging } from "./tagging";
import {
	InvalidRuntimeRequestError,
	validateCacheFeedbackRequest,
	validateComposeRequest,
	validateMaintenancePollRequest,
	validateObserveRequest,
	validateResolveHostCallbackRequest,
	validateSessionLifecycleRequest,
	validateToolEventRequest,
	validateToolExecuteRequest,
} from "./validation";

export interface RuntimeCallEnvelope {
	method: string;
	params: unknown;
}

export interface MagicContextRuntimeOptions {
	store?: RuntimeStateStore;
	storage?: RuntimeStorage;
	memory?: RuntimeMemory;
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

/** Deep runtime Module behind the two-method agent-plugin Interface. */
export class MagicContextRuntime {
	readonly #store: RuntimeStateStore;
	readonly #policy: RuntimePolicyConfig;
	readonly #now: () => number;
	readonly #memory: RuntimeMemory;
	readonly #control: RuntimeControlPlane;
	readonly #auxiliary: RuntimeAuxiliaryCoordinator;
	readonly #tagging: RuntimeTagging;
	readonly #injection: RuntimeInjection;

	constructor(options: MagicContextRuntimeOptions) {
		if (!options.storage && !options.store) {
			throw new Error("MagicContextRuntime requires storage or a state store");
		}
		this.#store =
			options.storage?.sessions ?? (options.store as RuntimeStateStore);
		this.#memory =
			options.memory ??
			options.storage?.memory ??
			RuntimeStorage.inMemory().memory;
		this.#policy = normalizeRuntimePolicy(options.policy);
		this.#now = options.now ?? Date.now;
		this.#control = new RuntimeControlPlane(
			this.#store,
			this.#memory,
			this.#now,
		);
		this.#auxiliary = new RuntimeAuxiliaryCoordinator(
			this.#store,
			this.#memory,
			this.#now,
		);
		this.#tagging = new RuntimeTagging(this.#store, this.#now);
		this.#injection = new RuntimeInjection(
			this.#store,
			this.#memory,
			this.#auxiliary,
			this.#tagging,
			this.#policy,
			this.#now,
		);
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
			case "tool.execute":
				return this.#control.executeTool(
					validateToolExecuteRequest(call.params),
				);
			case "session.lifecycle": {
				const request = validateSessionLifecycleRequest(call.params);
				if (request.action === "start") {
					await this.#auxiliary.configure(
						identity(request),
						request.auxiliaryPolicy,
					);
				}
				return this.#control.lifecycle(request);
			}
			case "cache.observe":
				return this.#control.observeCache(
					validateCacheFeedbackRequest(call.params),
				);
			case "tool.observe":
				return this.#control.observeTool(validateToolEventRequest(call.params));
			case "maintenance.poll":
				return this.#auxiliary.poll(
					validateMaintenancePollRequest(call.params),
				);
			case "host.callback.resolve":
				return this.#auxiliary.resolve(
					validateResolveHostCallbackRequest(call.params),
				);
			default:
				throw new UnknownRuntimeMethodError(String(call.method));
		}
	}

	async #compose(params: unknown): Promise<ContextPlan> {
		const request = validateComposeRequest(params);
		const sessionIdentity = identity(request);
		const snapshot = await this.#store.readSession(sessionIdentity);
		if (snapshot.lastCompose?.requestId === request.requestId) {
			return snapshot.lastCompose.plan;
		}
		const injection = await this.#injection.prepare(request);
		return this.#store.updateSession(sessionIdentity, (state) => {
			if (state.lastCompose?.requestId === request.requestId) {
				return { state, result: state.lastCompose.plan };
			}
			const nowMs = this.#now();
			const composed = composeContext(
				request,
				state,
				this.#policy,
				nowMs,
				injection.knowledge,
				injection.triggers,
				injection.tagging,
			);
			const plan: ContextPlan =
				injection.callbacks.length > 0
					? {
							...composed.plan,
							callbacks: structuredClone(injection.callbacks),
						}
					: composed.plan;
			const consumedTriggers = new Set(injection.triggers?.triggerIds ?? []);
			const next = {
				...state,
				revision: state.revision + 1,
				lastComposeAtMs: nowMs,
				drainLatchActiveSinceMs: composed.drainLatchActiveSinceMs,
				deferredExecute: composed.deferredExecute,
				activeMemoryFingerprint: composed.activeMemoryFingerprint,
				activeMemoryEpoch: composed.activeMemoryEpoch,
				activeTagFingerprint: composed.activeTagFingerprint,
				pendingTriggers: state.pendingTriggers.filter(
					(trigger) => !consumedTriggers.has(trigger.id),
				),
				lastCompose: {
					requestId: request.requestId,
					plan,
				},
			};
			return { state: next, result: plan };
		});
	}

	async #observe(params: unknown): Promise<TurnObservationReceipt> {
		const observation = validateObserveRequest(params);
		const sessionIdentity = identity(observation);
		const snapshot = await this.#store.readSession(sessionIdentity);
		if (snapshot.recentObservationIds.includes(observation.observationId)) {
			const callbacks = await this.#auxiliary.afterObservation(observation);
			const receipt = this.#receipt(observation, false, snapshot.revision);
			return callbacks.length > 0 ? { ...receipt, callbacks } : receipt;
		}
		await this.#memory.remember({
			projectKey: memoryProjectKey(observation),
			sessionId: observation.sessionId,
			observationId: observation.observationId,
			observedAtMs: observation.observedAtMs,
			candidates: observation.memoryCandidates ?? [],
		});
		const receipt = await this.#store.updateSession(
			sessionIdentity,
			(state) => {
				if (state.recentObservationIds.includes(observation.observationId)) {
					return {
						state,
						result: this.#receipt(observation, false, state.revision),
					};
				}
				const revision = state.revision + 1;
				const { messages, memoryCandidates, ...observationMetadata } =
					observation;
				const observations = [
					...state.observations,
					{
						...observationMetadata,
						messageCount: messages.length,
						memoryCandidateCount: memoryCandidates?.length ?? 0,
					},
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
						projectId: observation.projectId ?? state.projectId,
						modelKey: observation.modelKey ?? state.modelKey,
						lastCompose: undefined,
					},
					result: this.#receipt(observation, true, revision),
				};
			},
		);
		const callbacks = await this.#auxiliary.afterObservation(observation);
		return callbacks.length > 0 ? { ...receipt, callbacks } : receipt;
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
		memoryBudgetPercentage: numericEnvironment(
			environment,
			"MAGIC_CONTEXT_MEMORY_BUDGET_PERCENTAGE",
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
	const directory = defaultRuntimeStateDirectory(environment);
	return new MagicContextRuntime({
		storage: RuntimeStorage.jsonDirectory(directory),
		policy: runtimePolicyFromEnvironment(environment),
	});
}
