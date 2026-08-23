import { createHash } from "node:crypto";

import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type ObservedMemoryCandidate,
} from "@cortexkit/magic-context-core-plugin";

import type {
	RuntimeMemoryEmbedding,
	RuntimeMemoryRecord,
	RuntimeMemoryStore,
} from "./memory-store";

const CATEGORY_ORDER: readonly MemoryCategory[] = [
	"PROJECT_RULES",
	"ARCHITECTURE",
	"CONSTRAINTS",
	"CONFIG_VALUES",
	"NAMING",
];
const SEMANTIC_WEIGHT = 0.7;
const LEXICAL_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const MAX_SOURCE_OBSERVATIONS = 64;
const MAX_MEMORY_CANDIDATES = 128;
const MAX_MEMORY_CHARACTERS = 64_000;
const MAX_METADATA_CHARACTERS = 64_000;
const MAX_EMBEDDING_DIMENSIONS = 4_096;
const MAX_TERMS = 4_096;

export interface EmbeddingAdapter {
	readonly identity: string;
	embed(text: string): Promise<number[] | undefined>;
}

/**
 * Dependency-free embedding Adapter. Feature hashing gives deterministic local
 * similarity while callers may replace it with a provider-backed Adapter.
 */
export class HashingEmbeddingAdapter implements EmbeddingAdapter {
	readonly identity: string;
	readonly dimensions: number;

	constructor(dimensions = 256) {
		this.dimensions = Math.min(
			MAX_EMBEDDING_DIMENSIONS,
			Math.max(32, Number.isFinite(dimensions) ? Math.floor(dimensions) : 256),
		);
		this.identity = `feature-hash-v1:${this.dimensions}`;
	}

	async embed(text: string): Promise<number[] | undefined> {
		const terms = tokenize(text);
		if (terms.length === 0) return undefined;
		const vector = Array.from({ length: this.dimensions }, () => 0);
		const features = [
			...terms,
			...terms
				.slice(0, -1)
				.map((term, index) => `${term}\0${terms[index + 1]}`),
		];
		for (const feature of features) {
			const digest = createHash("sha256").update(feature).digest();
			const index = digest.readUInt32BE(0) % this.dimensions;
			const sign = (digest[4] & 1) === 0 ? 1 : -1;
			vector[index] += sign;
		}
		const norm = Math.sqrt(
			vector.reduce((sum, value) => sum + value * value, 0),
		);
		return norm > 0 ? vector.map((value) => value / norm) : undefined;
	}
}

export class InvalidMemoryCandidateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidMemoryCandidateError";
	}
}

export interface RememberMemoriesInput {
	projectKey: string;
	sessionId: string;
	observationId: string;
	observedAtMs: number;
	candidates: readonly ObservedMemoryCandidate[];
}

export interface RememberMemoriesResult {
	revision: number;
	insertedIds: number[];
	updatedIds: number[];
}

export interface RecallMemoriesInput {
	projectKey: string;
	query: string;
	limit?: number;
	excludeIds?: readonly number[];
	nowMs?: number;
}

export interface RecalledMemory {
	memory: RuntimeMemoryRecord;
	score: number;
	semanticScore?: number;
	lexicalScore?: number;
}

export interface RecallMemoriesResult {
	projectKey: string;
	revision: number;
	items: RecalledMemory[];
}

export interface RenderedMemoryRecall {
	content: string;
	epoch: number;
	fingerprint: string;
	estimatedTokens: number;
	memoryIds: number[];
}

export function normalizeMemoryContent(content: string): string {
	return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedMemoryHash(content: string): string {
	return createHash("md5")
		.update(normalizeMemoryContent(content))
		.digest("hex");
}

function tokenize(content: string): string[] {
	const atoms =
		normalizeMemoryContent(content).match(
			/[\p{Script=Han}]|[\p{L}\p{N}_./:-]+/gu,
		) ?? [];
	const terms: string[] = [];
	for (const [index, atom] of atoms.entries()) {
		terms.push(atom);
		if (
			index > 0 &&
			/^\p{Script=Han}$/u.test(atom) &&
			/^\p{Script=Han}$/u.test(atoms[index - 1])
		) {
			terms.push(`${atoms[index - 1]}${atom}`);
		}
		if (terms.length >= MAX_TERMS) break;
	}
	return terms.slice(0, MAX_TERMS);
}

function assertRememberInput(input: RememberMemoriesInput): void {
	if (input.projectKey.trim() === "") {
		throw new InvalidMemoryCandidateError("projectKey must not be blank");
	}
	if (input.sessionId.trim() === "" || input.observationId.trim() === "") {
		throw new InvalidMemoryCandidateError(
			"sessionId and observationId must not be blank",
		);
	}
	if (!Number.isFinite(input.observedAtMs) || input.observedAtMs < 0) {
		throw new InvalidMemoryCandidateError(
			"observedAtMs must be finite and non-negative",
		);
	}
	if (input.candidates.length > MAX_MEMORY_CANDIDATES) {
		throw new InvalidMemoryCandidateError(
			`at most ${MAX_MEMORY_CANDIDATES} memory candidates may be observed`,
		);
	}
	for (const [index, candidate] of input.candidates.entries()) {
		if (
			!(MEMORY_CATEGORIES as readonly string[]).includes(candidate.category)
		) {
			throw new InvalidMemoryCandidateError(
				`memory candidate ${index} has an unsupported category`,
			);
		}
		if (
			candidate.content.trim() === "" ||
			candidate.content.length > MAX_MEMORY_CHARACTERS
		) {
			throw new InvalidMemoryCandidateError(
				`memory candidate ${index} content is blank or too large`,
			);
		}
		if (
			candidate.importance !== undefined &&
			(!Number.isFinite(candidate.importance) ||
				candidate.importance < 0 ||
				candidate.importance > 100)
		) {
			throw new InvalidMemoryCandidateError(
				`memory candidate ${index} importance must be between 0 and 100`,
			);
		}
		if (
			candidate.expiresAtMs !== undefined &&
			(!Number.isFinite(candidate.expiresAtMs) || candidate.expiresAtMs < 0)
		) {
			throw new InvalidMemoryCandidateError(
				`memory candidate ${index} expiresAtMs is invalid`,
			);
		}
		if (candidate.metadata !== undefined) {
			try {
				const serialized = JSON.stringify(candidate.metadata);
				if (serialized.length > MAX_METADATA_CHARACTERS) {
					throw new Error("metadata too large");
				}
			} catch {
				throw new InvalidMemoryCandidateError(
					`memory candidate ${index} metadata must be bounded JSON`,
				);
			}
		}
	}
}

async function safeEmbed(
	adapter: EmbeddingAdapter,
	content: string,
): Promise<number[] | undefined> {
	try {
		const values = await adapter.embed(content.slice(0, MAX_MEMORY_CHARACTERS));
		if (
			!values ||
			values.length === 0 ||
			values.length > MAX_EMBEDDING_DIMENSIONS ||
			values.some((value) => !Number.isFinite(value))
		) {
			return undefined;
		}
		return values;
	} catch {
		return undefined;
	}
}

function clampImportance(value: number | undefined): number {
	return Number.isFinite(value)
		? Math.min(100, Math.max(0, Math.round(value ?? 50)))
		: 50;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]) {
	if (left.length === 0 || left.length !== right.length) return 0;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index] * right[index];
		leftNorm += left[index] * left[index];
		rightNorm += right[index] * right[index];
	}
	const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
	return denominator === 0 ? 0 : dot / denominator;
}

function lexicalScores(
	query: string,
	memories: readonly RuntimeMemoryRecord[],
): Map<number, number> {
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || memories.length === 0) return new Map();
	const documents = memories.map((memory) => tokenize(memory.content));
	const averageLength =
		documents.reduce((sum, terms) => sum + terms.length, 0) /
		Math.max(1, documents.length);
	const documentFrequency = new Map<string, number>();
	for (const terms of documents) {
		for (const term of new Set(terms)) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}
	const raw = new Map<number, number>();
	const k1 = 1.2;
	const b = 0.75;
	for (const [index, memory] of memories.entries()) {
		const terms = documents[index];
		const frequency = new Map<string, number>();
		for (const term of terms)
			frequency.set(term, (frequency.get(term) ?? 0) + 1);
		let score = 0;
		for (const term of queryTerms) {
			const count = frequency.get(term) ?? 0;
			if (count === 0) continue;
			const seenIn = documentFrequency.get(term) ?? 0;
			const idf = Math.log(
				1 + (memories.length - seenIn + 0.5) / (seenIn + 0.5),
			);
			const denominator =
				count + k1 * (1 - b + b * (terms.length / Math.max(1, averageLength)));
			score += idf * ((count * (k1 + 1)) / denominator);
		}
		if (score > 0) raw.set(memory.id, score);
	}
	const maximum = Math.max(0, ...raw.values());
	if (maximum === 0) return new Map();
	return new Map([...raw].map(([id, score]) => [id, score / maximum]));
}

function isVisible(memory: RuntimeMemoryRecord, nowMs: number): boolean {
	return (
		(memory.status === "active" || memory.status === "permanent") &&
		(memory.expiresAtMs === undefined || memory.expiresAtMs > nowMs)
	);
}

function memoryEmbedding(
	identity: string,
	values: number[] | undefined,
): RuntimeMemoryEmbedding | undefined {
	return values && values.length > 0 ? { identity, values } : undefined;
}

function categoryRank(category: MemoryCategory): number {
	const index = CATEGORY_ORDER.indexOf(category);
	return index < 0 ? CATEGORY_ORDER.length : index;
}

function xmlEscape(content: string): string {
	return content
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function estimateTextTokens(content: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(content, "utf8") / 3));
}

function renderMemories(memories: readonly RuntimeMemoryRecord[]): string {
	const groups = new Map<MemoryCategory, RuntimeMemoryRecord[]>();
	for (const memory of memories) {
		const group = groups.get(memory.category) ?? [];
		group.push(memory);
		groups.set(memory.category, group);
	}
	const sections = [...groups]
		.sort(([left], [right]) => categoryRank(left) - categoryRank(right))
		.map(([category, group]) => {
			const lines = [...group]
				.sort((left, right) => left.id - right.id)
				.map((memory) => `#${memory.id}: ${xmlEscape(memory.content)}`);
			return `<${category}>\n${lines.join("\n")}\n</${category}>`;
		});
	return `<project-memory>\n${sections.join("\n")}\n</project-memory>`;
}

/**
 * Deep Memory Module: canonical records, exact deduplication, persistence,
 * hybrid recall, deterministic rendering, and budget enforcement live here.
 */
export class RuntimeMemory {
	constructor(
		readonly store: RuntimeMemoryStore,
		readonly embeddings: EmbeddingAdapter = new HashingEmbeddingAdapter(),
	) {}

	async remember(
		input: RememberMemoriesInput,
	): Promise<RememberMemoriesResult> {
		assertRememberInput(input);
		if (input.candidates.length === 0) {
			const collection = await this.store.readProject(input.projectKey);
			return { revision: collection.revision, insertedIds: [], updatedIds: [] };
		}
		const prepared = await Promise.all(
			input.candidates.map(async (candidate) => ({
				candidate: clone(candidate),
				normalizedHash: computeNormalizedMemoryHash(candidate.content),
				embedding: memoryEmbedding(
					this.embeddings.identity,
					await safeEmbed(this.embeddings, candidate.content),
				),
			})),
		);
		return this.store.updateProject(input.projectKey, (collection) => {
			const insertedIds: number[] = [];
			const updatedIds: number[] = [];
			let changed = false;
			for (const item of prepared) {
				const { candidate, normalizedHash, embedding } = item;
				const existing = collection.memories.find(
					(memory) =>
						memory.category === candidate.category &&
						memory.normalizedHash === normalizedHash,
				);
				if (existing) {
					if (existing.sourceObservationIds.includes(input.observationId)) {
						continue;
					}
					existing.seenCount += 1;
					existing.lastSeenAtMs = input.observedAtMs;
					existing.updatedAtMs = input.observedAtMs;
					existing.importance = Math.max(
						existing.importance,
						clampImportance(candidate.importance),
					);
					existing.sourceObservationIds = [
						...existing.sourceObservationIds,
						input.observationId,
					].slice(-MAX_SOURCE_OBSERVATIONS);
					if (
						embedding &&
						existing.embedding?.identity !== embedding.identity
					) {
						existing.embedding = embedding;
					}
					updatedIds.push(existing.id);
					changed = true;
					continue;
				}
				const id = collection.nextId;
				collection.nextId += 1;
				collection.memories.push({
					id,
					projectKey: input.projectKey,
					category: candidate.category,
					content: candidate.content.trim(),
					normalizedHash,
					importance: clampImportance(candidate.importance),
					scope: candidate.scope ?? "project",
					shareable: candidate.shareable ?? false,
					sourceSessionId: input.sessionId,
					sourceType: candidate.sourceType ?? "historian",
					seenCount: 1,
					retrievalCount: 0,
					firstSeenAtMs: input.observedAtMs,
					createdAtMs: input.observedAtMs,
					updatedAtMs: input.observedAtMs,
					lastSeenAtMs: input.observedAtMs,
					status: "active",
					expiresAtMs: candidate.expiresAtMs,
					verificationStatus: "unverified",
					mergedFrom: [],
					metadata: candidate.metadata,
					embedding,
					sourceObservationIds: [input.observationId],
				});
				insertedIds.push(id);
				changed = true;
			}
			if (changed) collection.revision += 1;
			return {
				collection,
				result: { revision: collection.revision, insertedIds, updatedIds },
			};
		});
	}

	async recall(input: RecallMemoriesInput): Promise<RecallMemoriesResult> {
		const collection = await this.store.readProject(input.projectKey);
		const nowMs = input.nowMs ?? Date.now();
		const excluded = new Set(input.excludeIds ?? []);
		const memories = collection.memories.filter(
			(memory) => isVisible(memory, nowMs) && !excluded.has(memory.id),
		);
		const lexical = lexicalScores(input.query, memories);
		const queryEmbedding = await safeEmbed(this.embeddings, input.query);
		const items = memories
			.map((memory): RecalledMemory | undefined => {
				const lexicalScore = lexical.get(memory.id);
				const semanticScore =
					queryEmbedding &&
					memory.embedding?.identity === this.embeddings.identity
						? Math.max(
								0,
								cosineSimilarity(queryEmbedding, memory.embedding.values),
							)
						: undefined;
				const hasLexical = lexicalScore !== undefined && lexicalScore > 0;
				const hasSemantic =
					semanticScore !== undefined && semanticScore >= 0.08;
				if (!hasLexical && !hasSemantic) return undefined;
				const score =
					hasLexical && hasSemantic
						? SEMANTIC_WEIGHT * semanticScore + LEXICAL_WEIGHT * lexicalScore
						: SINGLE_SOURCE_PENALTY *
							(hasSemantic ? semanticScore : (lexicalScore ?? 0));
				return { memory: clone(memory), score, semanticScore, lexicalScore };
			})
			.filter((item): item is RecalledMemory => item !== undefined)
			.sort(
				(left, right) =>
					right.score - left.score ||
					right.memory.importance - left.memory.importance ||
					left.memory.id - right.memory.id,
			)
			.slice(0, Math.max(0, Math.floor(input.limit ?? 20)));
		return {
			projectKey: input.projectKey,
			revision: collection.revision,
			items,
		};
	}

	async recallAndRender(
		input: RecallMemoriesInput & { budgetTokens: number },
	): Promise<RenderedMemoryRecall | undefined> {
		if (input.budgetTokens <= 0 || normalizeMemoryContent(input.query) === "") {
			return undefined;
		}
		const recalled = await this.recall(input);
		const selected: RuntimeMemoryRecord[] = [];
		for (const item of recalled.items) {
			const candidate = [...selected, item.memory];
			if (estimateTextTokens(renderMemories(candidate)) <= input.budgetTokens) {
				selected.push(item.memory);
			}
		}
		if (selected.length === 0) return undefined;
		const content = renderMemories(selected);
		return {
			content,
			epoch: recalled.revision,
			fingerprint: createHash("sha256").update(content).digest("hex"),
			estimatedTokens: estimateTextTokens(content),
			memoryIds: selected.map((memory) => memory.id),
		};
	}

	async recordRetrieval(
		projectKey: string,
		memoryIds: readonly number[],
		retrievedAtMs = Date.now(),
	): Promise<number> {
		const ids = new Set(memoryIds);
		if (ids.size === 0) return 0;
		return this.store.updateProject(projectKey, (collection) => {
			let updated = 0;
			for (const memory of collection.memories) {
				if (!ids.has(memory.id)) continue;
				memory.retrievalCount += 1;
				memory.lastRetrievedAtMs = retrievedAtMs;
				memory.updatedAtMs = retrievedAtMs;
				updated += 1;
			}
			if (updated > 0) collection.revision += 1;
			return { collection, result: updated };
		});
	}
}

export function memoryProjectKey(value: {
	host: string;
	sessionId: string;
	projectId?: string;
}): string {
	return value.projectId?.trim() || `session:${value.host}:${value.sessionId}`;
}
