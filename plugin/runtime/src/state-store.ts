import { createHash } from "node:crypto";

import type {
	AuxiliaryLlmRequest,
	AuxiliaryRuntimePolicy,
	AuxiliaryTaskName,
	CacheFeedbackRequest,
	CanonicalMessage,
	ContextPlan,
	ContextToolExecutionResult,
	ContextUsageObservation,
	DeferredExecuteIntent,
	ObserveTurnRequest,
	SessionLifecycleAction,
	ToolEventPhase,
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

export type RuntimeNoteStatus = "active" | "pending" | "ready" | "dismissed";

export interface RuntimeNote {
	id: number;
	type: "session" | "smart";
	content: string;
	status: RuntimeNoteStatus;
	surfaceCondition?: string;
	readyReason?: string;
	anchorOrdinal?: number;
	createdAtMs: number;
	updatedAtMs: number;
	lastReadAtMs?: number;
}

export interface RuntimeAutomaticTrigger {
	id: string;
	kind:
		| "large_tool_result"
		| "smart_note_ready"
		| "cache_pressure"
		| "sidekick_augmentation";
	content: string;
	createdAtMs: number;
}

export interface RuntimeToolEventRecord {
	eventId: string;
	phase: ToolEventPhase;
	toolName: string;
	observedAtMs: number;
	status?: string;
	durationMs?: number;
	resultCharacters?: number;
}

export interface RuntimeLifecycleRecord {
	eventId: string;
	action: SessionLifecycleAction;
	observedAtMs: number;
	reason?: string;
	targetSessionId?: string;
}

export interface RuntimeCacheFeedback {
	latest?: CacheFeedbackRequest;
	cumulativeCacheReadTokens: number;
	cumulativeCacheWriteTokens: number;
	recentEventIds: string[];
}

export type RuntimeAuxiliaryJobStatus =
	| "queued"
	| "leased"
	| "completed"
	| "failed";

export interface RuntimeAuxiliaryJob {
	callbackId: string;
	task: AuxiliaryTaskName;
	taskKey: string;
	purpose: string;
	status: RuntimeAuxiliaryJobStatus;
	createdAtMs: number;
	nextAttemptAtMs: number;
	attempts: number;
	maxAttempts: number;
	timeoutMs: number;
	leaseExpiresAtMs?: number;
	completedAtMs?: number;
	lastError?: string;
	sourceKey: string;
	projectKey: string;
	sourceObservationId?: string;
	sourceOrdinals?: number[];
	queryHash?: string;
	request?: AuxiliaryLlmRequest;
}

export interface RuntimeHistorianCompartment {
	id: string;
	callbackId: string;
	startOrdinal: number;
	endOrdinal: number;
	title: string;
	episodeType: string;
	importance: number;
	p1: string;
	p2: string;
	p3: string;
	p4: string;
	publishedAtMs: number;
}

export interface RuntimeAuxiliaryState {
	policy?: AuxiliaryRuntimePolicy;
	jobs: RuntimeAuxiliaryJob[];
	completedCallbackIds: string[];
	historianCursorOrdinal: number;
	historianFailureCount: number;
	historianLastError?: string;
	historianLastSuccessAtMs?: number;
	compartments: RuntimeHistorianCompartment[];
	dreamerFailureCount: number;
	dreamerLastError?: string;
	dreamerLastSuccessAtMs?: number;
	sidekickFailureCount: number;
	sidekickLastError?: string;
	recentSidekickQueryHashes: string[];
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
	projectId?: string;
	modelKey?: string;
	nextNoteId: number;
	notes: RuntimeNote[];
	droppedMessageOrdinals: number[];
	pendingTriggers: RuntimeAutomaticTrigger[];
	toolEvents: RuntimeToolEventRecord[];
	lifecycleEvents: RuntimeLifecycleRecord[];
	lifecycleMessages?: CanonicalMessage[];
	cacheFeedback: RuntimeCacheFeedback;
	recentToolResults: ContextToolExecutionResult[];
	auxiliary: RuntimeAuxiliaryState;
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
	deleteSession(identity: RuntimeSessionIdentity): Promise<boolean>;
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
		nextNoteId: 1,
		notes: [],
		droppedMessageOrdinals: [],
		pendingTriggers: [],
		toolEvents: [],
		lifecycleEvents: [],
		cacheFeedback: {
			cumulativeCacheReadTokens: 0,
			cumulativeCacheWriteTokens: 0,
			recentEventIds: [],
		},
		recentToolResults: [],
		auxiliary: {
			jobs: [],
			completedCallbackIds: [],
			historianCursorOrdinal: 0,
			historianFailureCount: 0,
			compartments: [],
			dreamerFailureCount: 0,
			sidekickFailureCount: 0,
			recentSidekickQueryHashes: [],
		},
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

	async deleteSession(identity: RuntimeSessionIdentity): Promise<boolean> {
		return this.#sessions.delete(`${identity.host}\0${identity.sessionId}`);
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
	return {
		...emptyRuntimeSessionState(identity),
		...state,
		nextNoteId: Number.isInteger(state.nextNoteId)
			? Number(state.nextNoteId)
			: 1,
		notes: Array.isArray(state.notes) ? state.notes : [],
		droppedMessageOrdinals: Array.isArray(state.droppedMessageOrdinals)
			? state.droppedMessageOrdinals
			: [],
		pendingTriggers: Array.isArray(state.pendingTriggers)
			? state.pendingTriggers
			: [],
		toolEvents: Array.isArray(state.toolEvents) ? state.toolEvents : [],
		lifecycleEvents: Array.isArray(state.lifecycleEvents)
			? state.lifecycleEvents
			: [],
		cacheFeedback:
			state.cacheFeedback && typeof state.cacheFeedback === "object"
				? state.cacheFeedback
				: {
						cumulativeCacheReadTokens: 0,
						cumulativeCacheWriteTokens: 0,
						recentEventIds: [],
					},
		recentToolResults: Array.isArray(state.recentToolResults)
			? state.recentToolResults
			: [],
		auxiliary:
			state.auxiliary && typeof state.auxiliary === "object"
				? {
						...emptyRuntimeSessionState(identity).auxiliary,
						...state.auxiliary,
						jobs: Array.isArray(state.auxiliary.jobs)
							? state.auxiliary.jobs
							: [],
						completedCallbackIds: Array.isArray(
							state.auxiliary.completedCallbackIds,
						)
							? state.auxiliary.completedCallbackIds
							: [],
						compartments: Array.isArray(state.auxiliary.compartments)
							? state.auxiliary.compartments
							: [],
						recentSidekickQueryHashes: Array.isArray(
							state.auxiliary.recentSidekickQueryHashes,
						)
							? state.auxiliary.recentSidekickQueryHashes
							: [],
					}
				: emptyRuntimeSessionState(identity).auxiliary,
	} as RuntimeSessionState;
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

	async deleteSession(identity: RuntimeSessionIdentity): Promise<boolean> {
		try {
			return await this.#documents.delete(sessionFileName(identity));
		} catch (error) {
			if (error instanceof RuntimeStateStoreError) throw error;
			throw new RuntimeStateStoreError("failed to delete runtime state", {
				cause: error,
			});
		}
	}
}
