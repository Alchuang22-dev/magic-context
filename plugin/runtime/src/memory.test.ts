import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	computeNormalizedMemoryHash,
	type EmbeddingAdapter,
	normalizeMemoryContent,
	RuntimeMemory,
} from "./memory";
import {
	JsonDirectoryRuntimeMemoryStore,
	MemoryRuntimeMemoryStore,
} from "./memory-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

class TestEmbeddingAdapter implements EmbeddingAdapter {
	readonly identity = "test-v1";

	async embed(text: string): Promise<number[]> {
		const normalized = text.toLowerCase();
		if (normalized.includes("authentication") || normalized.includes("jwt")) {
			return [1, 0];
		}
		return [0, 1];
	}
}

describe("RuntimeMemory", () => {
	test("preserves the original normalization and hash compatibility", () => {
		expect(normalizeMemoryContent("  Use   Bun\nTESTS ")).toBe("use bun tests");
		expect(computeNormalizedMemoryHash("Use Bun Tests")).toBe(
			computeNormalizedMemoryHash(" use   bun tests "),
		);
		expect(computeNormalizedMemoryHash("Use Bun Tests")).toBe(
			"6216b02748f86f7a018ea971d12bc12e",
		);
	});

	test("deduplicates retries and counts independent observations", async () => {
		const store = new MemoryRuntimeMemoryStore();
		const memory = new RuntimeMemory(store);
		const input = {
			projectKey: "project-a",
			sessionId: "session-a",
			observationId: "observation-a",
			observedAtMs: 1_000,
			candidates: [
				{
					category: "PROJECT_RULES" as const,
					content: "Use Bun for package scripts.",
					importance: 70,
				},
			],
		};

		const first = await memory.remember(input);
		const retry = await memory.remember(input);
		const repeated = await memory.remember({
			...input,
			observationId: "observation-b",
			observedAtMs: 2_000,
		});
		const stored = await store.readProject("project-a");

		expect(first.insertedIds).toEqual([1]);
		expect(retry.revision).toBe(first.revision);
		expect(repeated.updatedIds).toEqual([1]);
		expect(stored.memories).toHaveLength(1);
		expect(stored.memories[0].seenCount).toBe(2);
		expect(stored.memories[0].sourceObservationIds).toEqual([
			"observation-a",
			"observation-b",
		]);
	});

	test("fuses semantic and lexical recall with deterministic ties", async () => {
		const memory = new RuntimeMemory(
			new MemoryRuntimeMemoryStore(),
			new TestEmbeddingAdapter(),
		);
		await memory.remember({
			projectKey: "project-a",
			sessionId: "session-a",
			observationId: "observation-a",
			observedAtMs: 1_000,
			candidates: [
				{
					category: "ARCHITECTURE",
					content: "JWT checks live in the gateway.",
					importance: 90,
				},
				{
					category: "NAMING",
					content: "Authentication examples use the AuthCase suffix.",
					importance: 50,
				},
				{
					category: "PROJECT_RULES",
					content: "Run formatter before committing.",
				},
			],
		});

		const recalled = await memory.recall({
			projectKey: "project-a",
			query: "Where is authentication validation?",
		});

		expect(recalled.items.map((item) => item.memory.id)).toEqual([2, 1]);
		expect(recalled.items[0].lexicalScore).toBeGreaterThan(0);
		expect(recalled.items[0].semanticScore).toBe(1);
	});

	test("tokenizes CJK text for lexical recall", async () => {
		const memory = new RuntimeMemory(new MemoryRuntimeMemoryStore());
		await memory.remember({
			projectKey: "project-a",
			sessionId: "session-a",
			observationId: "observation-cjk",
			observedAtMs: 1_000,
			candidates: [
				{
					category: "ARCHITECTURE",
					content: "记忆存储和召回由 runtime 负责。",
				},
			],
		});

		const recalled = await memory.recall({
			projectKey: "project-a",
			query: "谁负责记忆召回？",
		});
		expect(recalled.items.map((item) => item.memory.id)).toEqual([1]);
	});

	test("filters expired and already-visible memories before rendering", async () => {
		const memory = new RuntimeMemory(new MemoryRuntimeMemoryStore());
		await memory.remember({
			projectKey: "project-a",
			sessionId: "session-a",
			observationId: "observation-a",
			observedAtMs: 1_000,
			candidates: [
				{
					category: "PROJECT_RULES",
					content: "Use <Bun> & lock dependencies.",
				},
				{
					category: "CONSTRAINTS",
					content: "Bun is temporarily unavailable.",
					expiresAtMs: 1_500,
				},
			],
		});

		const hidden = await memory.recallAndRender({
			projectKey: "project-a",
			query: "Bun dependencies",
			budgetTokens: 200,
			excludeIds: [1],
			nowMs: 2_000,
		});
		const rendered = await memory.recallAndRender({
			projectKey: "project-a",
			query: "Bun dependencies",
			budgetTokens: 200,
			nowMs: 1_200,
		});

		expect(hidden).toBeUndefined();
		expect(rendered?.content).toContain("&lt;Bun&gt; &amp; lock");
		expect(rendered?.content).toContain("<PROJECT_RULES>");
		expect(rendered?.estimatedTokens).toBeLessThanOrEqual(200);
	});

	test("persists concurrent project updates through the JSON Adapter", async () => {
		const directory = await mkdtemp(join(tmpdir(), "magic-context-memory-"));
		temporaryDirectories.push(directory);
		const first = new RuntimeMemory(
			new JsonDirectoryRuntimeMemoryStore(directory),
		);
		const second = new RuntimeMemory(
			new JsonDirectoryRuntimeMemoryStore(directory),
		);

		await Promise.all([
			first.remember({
				projectKey: "project-a",
				sessionId: "session-a",
				observationId: "observation-a",
				observedAtMs: 1_000,
				candidates: [
					{ category: "PROJECT_RULES", content: "Use Bun scripts." },
				],
			}),
			second.remember({
				projectKey: "project-a",
				sessionId: "session-b",
				observationId: "observation-b",
				observedAtMs: 2_000,
				candidates: [
					{ category: "ARCHITECTURE", content: "Runtime owns recall." },
				],
			}),
		]);

		const stored = await new JsonDirectoryRuntimeMemoryStore(
			directory,
		).readProject("project-a");
		expect(stored.revision).toBe(2);
		expect(stored.memories.map((item) => item.content).sort()).toEqual([
			"Runtime owns recall.",
			"Use Bun scripts.",
		]);
	});
});
