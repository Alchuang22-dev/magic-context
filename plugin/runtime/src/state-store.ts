import { createHash } from "node:crypto";

import type {
	ContextPlan,
	ContextUsageObservation,
	DeferredExecuteIntent,
	ObserveTurnRequest,
} from "@cortexkit/magic-context-core-plugin";

import {
	LockedJsonDirectory,
	type LockedJsonDirectoryOptions,
} from "./locked-json-directory";

export const RUNTIME_STATE_SCHEMA_VERSION = 1 as const;

export interface RuntimeSessionIdentity {
	host: string;
	sessionId: string;
}

export interface RuntimeTurnRecord {
	observationId: string;
	turnId?: string;
	taskId?: string;
	projectId?: string;
	modelKey?: string;
	observedAtMs: number;
	messageCount: number;
	memoryCandidateCount?: number;
	usage?: ContextUsageObservation;
	outcome: ObserveTurnRequest["outcome"];
}

export interface RuntimeSessionState extends RuntimeSessionIdentity {
	schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
	revision: number;
	lastResponseTimeMs: number;
	lastComposeAtMs?: number;
	latestUsage?: ContextUsageObservation;
	drainLatchActiveSinceMs?: number;
	deferredExecute?: DeferredExecuteIntent;
	activeMemoryFingerprint?: string;
	activeMemoryEpoch?: number;
	recentObservationIds: string[];
	observations: RuntimeTurnRecord[];
	latestObservation?: ObserveTurnRequest;
	lastCompose?: {
		requestId: string;
		plan: ContextPlan;
	};
}

export type SessionStateUpdate<T> = (state: RuntimeSessionState) => {
	state: RuntimeSessionState;
	result: T;
};

export interface RuntimeStateStore {
	readSession(identity: RuntimeSessionIdentity): Promise<RuntimeSessionState>;
	updateSession<T>(
		identity: RuntimeSessionIdentity,
		update: SessionStateUpdate<T>,
	): Promise<T>;
}

export class RuntimeStateStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RuntimeStateStoreError";
	}
}

export function emptyRuntimeSessionState(
	identity: RuntimeSessionIdentity,
): RuntimeSessionState {
	return {
		schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
		host: identity.host,
		sessionId: identity.sessionId,
		revision: 0,
		lastResponseTimeMs: 0,
		recentObservationIds: [],
		observations: [],
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/** In-memory Adapter for embedded runtimes and Interface tests. */
export class MemoryRuntimeStateStore implements RuntimeStateStore {
	readonly #sessions = new Map<string, RuntimeSessionState>();

	async readSession(
		identity: RuntimeSessionIdentity,
	): Promise<RuntimeSessionState> {
		const key = `${identity.host}\0${identity.sessionId}`;
		return clone(this.#sessions.get(key) ?? emptyRuntimeSessionState(identity));
	}

	async updateSession<T>(
		identity: RuntimeSessionIdentity,
		update: SessionStateUpdate<T>,
	): Promise<T> {
		const key = `${identity.host}\0${identity.sessionId}`;
		const current = clone(
			this.#sessions.get(key) ?? emptyRuntimeSessionState(identity),
		);
		const outcome = update(current);
		this.#sessions.set(key, clone(outcome.state));
		return clone(outcome.result);
	}
}

function sessionFileName(identity: RuntimeSessionIdentity): string {
	return `${createHash("sha256")
		.update(identity.host)
		.update("\0")
		.update(identity.sessionId)
		.digest("hex")}.json`;
}

function assertStoredState(
	value: unknown,
	identity: RuntimeSessionIdentity,
): RuntimeSessionState {
	if (!value || typeof value !== "object") {
		throw new RuntimeStateStoreError("stored runtime state must be an object");
	}
	const state = value as Partial<RuntimeSessionState>;
	if (
		state.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
		state.host !== identity.host ||
		state.sessionId !== identity.sessionId ||
		!Number.isInteger(state.revision) ||
		!Array.isArray(state.observations) ||
		!Array.isArray(state.recentObservationIds)
	) {
		throw new RuntimeStateStoreError(
			"stored runtime state is invalid or incompatible",
		);
	}
	return state as RuntimeSessionState;
}

export type JsonDirectoryRuntimeStateStoreOptions = LockedJsonDirectoryOptions;

/**
 * Durable per-session JSON Adapter for one-shot and long-running processes.
 * A per-session lock plus atomic rename serializes concurrent compose/observe calls.
 */
export class JsonDirectoryRuntimeStateStore implements RuntimeStateStore {
	readonly #documents: LockedJsonDirectory;

	constructor(
		readonly directory: string,
		options: JsonDirectoryRuntimeStateStoreOptions = {},
	) {
		this.#documents = new LockedJsonDirectory(directory, options);
	}

	async readSession(
		identity: RuntimeSessionIdentity,
	): Promise<RuntimeSessionState> {
		try {
			return await this.#documents.read(
				sessionFileName(identity),
				() => emptyRuntimeSessionState(identity),
				(value) => assertStoredState(value, identity),
			);
		} catch (error) {
			if (error instanceof RuntimeStateStoreError) throw error;
			throw new RuntimeStateStoreError("failed to read runtime state", {
				cause: error,
			});
		}
	}

	async updateSession<T>(
		identity: RuntimeSessionIdentity,
		update: SessionStateUpdate<T>,
	): Promise<T> {
		try {
			return await this.#documents.update(
				sessionFileName(identity),
				() => emptyRuntimeSessionState(identity),
				(value) => assertStoredState(value, identity),
				(current) => {
					const outcome = update(clone(current));
					return { value: outcome.state, result: outcome.result };
				},
			);
		} catch (error) {
			if (error instanceof RuntimeStateStoreError) throw error;
			throw new RuntimeStateStoreError("failed to update runtime state", {
				cause: error,
			});
		}
	}
}
