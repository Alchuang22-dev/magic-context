import { createHash } from "node:crypto";

import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryScope,
	type MemorySourceType,
} from "@cortexkit/magic-context-core-plugin";

import {
	LockedJsonDirectory,
	type LockedJsonDirectoryOptions,
} from "./locked-json-directory";

export const MEMORY_STORE_SCHEMA_VERSION = 1 as const;

export type RuntimeMemoryStatus = "active" | "permanent" | "archived";
export type RuntimeVerificationStatus =
	| "unverified"
	| "verified"
	| "stale"
	| "flagged";

export interface RuntimeMemoryEmbedding {
	identity: string;
	values: number[];
}

/** Durable host-neutral memory record owned by the runtime. */
export interface RuntimeMemoryRecord {
	id: number;
	projectKey: string;
	category: MemoryCategory;
	content: string;
	normalizedHash: string;
	importance: number;
	scope: MemoryScope;
	shareable: boolean;
	sourceSessionId?: string;
	sourceType: MemorySourceType;
	seenCount: number;
	retrievalCount: number;
	firstSeenAtMs: number;
	createdAtMs: number;
	updatedAtMs: number;
	lastSeenAtMs: number;
	lastRetrievedAtMs?: number;
	status: RuntimeMemoryStatus;
	expiresAtMs?: number;
	verificationStatus: RuntimeVerificationStatus;
	verifiedAtMs?: number;
	supersededByMemoryId?: number;
	mergedFrom: number[];
	metadata?: Record<string, unknown>;
	embedding?: RuntimeMemoryEmbedding;
	sourceObservationIds: string[];
}

export interface RuntimeMemoryCollection {
	schemaVersion: typeof MEMORY_STORE_SCHEMA_VERSION;
	projectKey: string;
	revision: number;
	nextId: number;
	memories: RuntimeMemoryRecord[];
}

export type MemoryCollectionUpdate<T> = (
	collection: RuntimeMemoryCollection,
) => {
	collection: RuntimeMemoryCollection;
	result: T;
};

/** Persistence Interface consumed by the Memory Module. */
export interface RuntimeMemoryStore {
	readProject(projectKey: string): Promise<RuntimeMemoryCollection>;
	updateProject<T>(
		projectKey: string,
		update: MemoryCollectionUpdate<T>,
	): Promise<T>;
}

export class RuntimeMemoryStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RuntimeMemoryStoreError";
	}
}

export function emptyRuntimeMemoryCollection(
	projectKey: string,
): RuntimeMemoryCollection {
	return {
		schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
		projectKey,
		revision: 0,
		nextId: 1,
		memories: [],
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function keyForProject(projectKey: string): string {
	return createHash("sha256").update(projectKey).digest("hex");
}

function memoryFileName(projectKey: string): string {
	return `${keyForProject(projectKey)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStoredMemory(value: unknown, projectKey: string): boolean {
	if (!isRecord(value)) return false;
	const embedding = value.embedding;
	const validEmbedding =
		embedding === undefined ||
		(isRecord(embedding) &&
			typeof embedding.identity === "string" &&
			Array.isArray(embedding.values) &&
			embedding.values.length <= 4_096 &&
			embedding.values.every(
				(item) => typeof item === "number" && Number.isFinite(item),
			));
	return (
		Number.isInteger(value.id) &&
		Number(value.id) > 0 &&
		value.projectKey === projectKey &&
		typeof value.category === "string" &&
		(MEMORY_CATEGORIES as readonly string[]).includes(value.category) &&
		typeof value.content === "string" &&
		typeof value.normalizedHash === "string" &&
		isFiniteNonNegative(value.importance) &&
		["project", "ecosystem", "universe"].includes(String(value.scope)) &&
		typeof value.shareable === "boolean" &&
		(value.sourceSessionId === undefined ||
			typeof value.sourceSessionId === "string") &&
		["historian", "agent", "dreamer", "tool"].includes(
			String(value.sourceType),
		) &&
		isFiniteNonNegative(value.seenCount) &&
		isFiniteNonNegative(value.retrievalCount) &&
		isFiniteNonNegative(value.firstSeenAtMs) &&
		isFiniteNonNegative(value.createdAtMs) &&
		isFiniteNonNegative(value.updatedAtMs) &&
		isFiniteNonNegative(value.lastSeenAtMs) &&
		(value.lastRetrievedAtMs === undefined ||
			isFiniteNonNegative(value.lastRetrievedAtMs)) &&
		["active", "permanent", "archived"].includes(String(value.status)) &&
		(value.expiresAtMs === undefined ||
			isFiniteNonNegative(value.expiresAtMs)) &&
		["unverified", "verified", "stale", "flagged"].includes(
			String(value.verificationStatus),
		) &&
		(value.verifiedAtMs === undefined ||
			isFiniteNonNegative(value.verifiedAtMs)) &&
		(value.supersededByMemoryId === undefined ||
			Number.isInteger(value.supersededByMemoryId)) &&
		Array.isArray(value.mergedFrom) &&
		value.mergedFrom.every((item) => Number.isInteger(item)) &&
		Array.isArray(value.sourceObservationIds) &&
		value.sourceObservationIds.every((item) => typeof item === "string") &&
		(value.metadata === undefined || isRecord(value.metadata)) &&
		validEmbedding
	);
}

function assertCollection(
	value: unknown,
	projectKey: string,
): RuntimeMemoryCollection {
	if (!value || typeof value !== "object") {
		throw new RuntimeMemoryStoreError(
			"stored memory collection must be an object",
		);
	}
	const collection = value as Partial<RuntimeMemoryCollection>;
	if (
		collection.schemaVersion !== MEMORY_STORE_SCHEMA_VERSION ||
		collection.projectKey !== projectKey ||
		!Number.isInteger(collection.revision) ||
		Number(collection.revision) < 0 ||
		!Number.isInteger(collection.nextId) ||
		Number(collection.nextId) < 1 ||
		!Array.isArray(collection.memories) ||
		!collection.memories.every((memory) => isStoredMemory(memory, projectKey))
	) {
		throw new RuntimeMemoryStoreError(
			"stored memory collection is invalid or incompatible",
		);
	}
	const maximumId = Math.max(
		0,
		...collection.memories.map((memory) => Number(memory.id)),
	);
	if (Number(collection.nextId) <= maximumId) {
		throw new RuntimeMemoryStoreError(
			"stored memory collection nextId is not monotonic",
		);
	}
	return collection as RuntimeMemoryCollection;
}

/** In-memory persistence Adapter for embedded runtimes and tests. */
export class MemoryRuntimeMemoryStore implements RuntimeMemoryStore {
	readonly #projects = new Map<string, RuntimeMemoryCollection>();

	async readProject(projectKey: string): Promise<RuntimeMemoryCollection> {
		return clone(
			this.#projects.get(projectKey) ??
				emptyRuntimeMemoryCollection(projectKey),
		);
	}

	async updateProject<T>(
		projectKey: string,
		update: MemoryCollectionUpdate<T>,
	): Promise<T> {
		const current = clone(
			this.#projects.get(projectKey) ??
				emptyRuntimeMemoryCollection(projectKey),
		);
		const outcome = update(current);
		this.#projects.set(projectKey, clone(outcome.collection));
		return clone(outcome.result);
	}
}

/** Durable per-project JSON persistence Adapter with atomic updates. */
export class JsonDirectoryRuntimeMemoryStore implements RuntimeMemoryStore {
	readonly #documents: LockedJsonDirectory;

	constructor(
		readonly directory: string,
		options: LockedJsonDirectoryOptions = {},
	) {
		this.#documents = new LockedJsonDirectory(directory, options);
	}

	async readProject(projectKey: string): Promise<RuntimeMemoryCollection> {
		try {
			return await this.#documents.read(
				memoryFileName(projectKey),
				() => emptyRuntimeMemoryCollection(projectKey),
				(value) => assertCollection(value, projectKey),
			);
		} catch (error) {
			if (error instanceof RuntimeMemoryStoreError) throw error;
			throw new RuntimeMemoryStoreError("failed to read runtime memories", {
				cause: error,
			});
		}
	}

	async updateProject<T>(
		projectKey: string,
		update: MemoryCollectionUpdate<T>,
	): Promise<T> {
		try {
			return await this.#documents.update(
				memoryFileName(projectKey),
				() => emptyRuntimeMemoryCollection(projectKey),
				(value) => assertCollection(value, projectKey),
				(current) => {
					const outcome = update(current);
					return { value: outcome.collection, result: outcome.result };
				},
			);
		} catch (error) {
			if (error instanceof RuntimeMemoryStoreError) throw error;
			throw new RuntimeMemoryStoreError("failed to update runtime memories", {
				cause: error,
			});
		}
	}
}
