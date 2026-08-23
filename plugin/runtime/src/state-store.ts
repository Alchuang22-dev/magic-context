import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type {
	ContextPlan,
	ContextUsageObservation,
	DeferredExecuteIntent,
	ObserveTurnRequest,
} from "@cortexkit/magic-context-core-plugin";

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

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String(error.code)
		: undefined;
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

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface JsonDirectoryRuntimeStateStoreOptions {
	lockTimeoutMs?: number;
	staleLockMs?: number;
}

/**
 * Durable per-session JSON Adapter for one-shot and long-running processes.
 * A per-session lock plus atomic rename serializes concurrent compose/observe calls.
 */
export class JsonDirectoryRuntimeStateStore implements RuntimeStateStore {
	readonly #lockTimeoutMs: number;
	readonly #staleLockMs: number;

	constructor(
		readonly directory: string,
		options: JsonDirectoryRuntimeStateStoreOptions = {},
	) {
		this.#lockTimeoutMs = Math.max(100, options.lockTimeoutMs ?? 2_000);
		this.#staleLockMs = Math.max(
			this.#lockTimeoutMs,
			options.staleLockMs ?? 30_000,
		);
	}

	async updateSession<T>(
		identity: RuntimeSessionIdentity,
		update: SessionStateUpdate<T>,
	): Promise<T> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const filePath = join(this.directory, sessionFileName(identity));
		const lockPath = `${filePath}.lock`;
		const lock = await this.#acquireLock(lockPath);
		try {
			const current = await this.#readState(filePath, identity);
			const outcome = update(clone(current));
			await this.#writeState(filePath, outcome.state);
			return clone(outcome.result);
		} finally {
			await lock.close().catch(() => undefined);
			await unlink(lockPath).catch(() => undefined);
		}
	}

	async #readState(
		filePath: string,
		identity: RuntimeSessionIdentity,
	): Promise<RuntimeSessionState> {
		try {
			const raw = await readFile(filePath, "utf8");
			return assertStoredState(JSON.parse(raw), identity);
		} catch (error) {
			if (errorCode(error) === "ENOENT")
				return emptyRuntimeSessionState(identity);
			if (error instanceof RuntimeStateStoreError) throw error;
			throw new RuntimeStateStoreError("failed to read runtime state", {
				cause: error,
			});
		}
	}

	async #writeState(
		filePath: string,
		state: RuntimeSessionState,
	): Promise<void> {
		const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporaryPath, filePath);
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			throw new RuntimeStateStoreError("failed to persist runtime state", {
				cause: error,
			});
		}
	}

	async #acquireLock(lockPath: string) {
		const startedAt = Date.now();
		for (;;) {
			try {
				return await open(lockPath, "wx", 0o600);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") {
					throw new RuntimeStateStoreError(
						"failed to acquire runtime state lock",
						{
							cause: error,
						},
					);
				}
				try {
					const lockStat = await stat(lockPath);
					if (Date.now() - lockStat.mtimeMs > this.#staleLockMs) {
						await unlink(lockPath);
						continue;
					}
				} catch (statError) {
					if (errorCode(statError) === "ENOENT") continue;
				}
				if (Date.now() - startedAt >= this.#lockTimeoutMs) {
					throw new RuntimeStateStoreError(
						"timed out acquiring runtime state lock",
					);
				}
				await delay(10);
			}
		}
	}
}
