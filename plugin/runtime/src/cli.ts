#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
	createDefaultRuntime,
	MagicContextRuntime,
	type RuntimeCallEnvelope,
	runtimePolicyFromEnvironment,
} from "./runtime";
import {
	JsonDirectoryRuntimeStateStore,
	MemoryRuntimeStateStore,
} from "./state-store";

interface ErrorShape {
	code: string;
	message: string;
}

function errorShape(error: unknown): ErrorShape {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "RUNTIME_ERROR";
	const message = error instanceof Error ? error.message : String(error);
	return { code, message };
}

export async function processRuntimeLine(
	runtime: MagicContextRuntime,
	line: string,
): Promise<string> {
	try {
		const call = JSON.parse(line) as RuntimeCallEnvelope;
		const result = await runtime.handle(call);
		return JSON.stringify({ result });
	} catch (error) {
		return JSON.stringify({ error: errorShape(error) });
	}
}

function runtimeFromArguments(args: readonly string[]): MagicContextRuntime {
	if (args.includes("--memory")) {
		return new MagicContextRuntime({
			store: new MemoryRuntimeStateStore(),
			policy: runtimePolicyFromEnvironment(),
		});
	}
	const stateIndex = args.indexOf("--state-dir");
	if (stateIndex >= 0) {
		const stateDirectory = args[stateIndex + 1];
		if (!stateDirectory) throw new Error("--state-dir requires a path");
		return new MagicContextRuntime({
			store: new JsonDirectoryRuntimeStateStore(stateDirectory),
			policy: runtimePolicyFromEnvironment(),
		});
	}
	return createDefaultRuntime();
}

export async function runStdio(
	args: readonly string[] = process.argv.slice(2),
) {
	if (args.includes("--help")) {
		process.stdout.write(
			"Usage: magic-context-runtime [--state-dir PATH | --memory]\n" +
				"Reads JSON or NDJSON calls from stdin and writes one response per line.\n",
		);
		return;
	}
	const runtime = runtimeFromArguments(args);
	const lines = createInterface({
		input: process.stdin,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		process.stdout.write(`${await processRuntimeLine(runtime, line)}\n`);
	}
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
	await runStdio();
}
