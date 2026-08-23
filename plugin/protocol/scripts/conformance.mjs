#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = resolve(root, "conformance/golden.json");
const golden = JSON.parse(await readFile(goldenPath, "utf8"));
const expected = golden.map((testCase) => ({
	id: testCase.id,
	accepted: testCase.valid,
}));

function run(name, command, args) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			CARGO_TARGET_DIR:
				process.env.CARGO_TARGET_DIR ??
				resolve(tmpdir(), "magic-context-protocol-conformance-v1"),
		},
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${name} conformance runner failed: ${result.error?.message ?? result.stderr ?? `status ${result.status}`}`,
		);
	}
	const output = result.stdout.trim().split(/\r?\n/).at(-1);
	try {
		return JSON.parse(output ?? "");
	} catch (error) {
		throw new Error(`${name} runner returned invalid JSON: ${output}`, {
			cause: error,
		});
	}
}

const runners = {
	typescript: run("TypeScript", "bun", [
		"run",
		resolve(root, "conformance/typescript.ts"),
	]),
	python: run("Python", process.env.PYTHON || "python3", [
		resolve(root, "conformance/python.py"),
	]),
	rust: run("Rust", process.env.CARGO || "cargo", [
		"run",
		"--quiet",
		"--manifest-path",
		resolve(root, "conformance/rust/Cargo.toml"),
		"--",
		goldenPath,
	]),
};

const canonical = JSON.stringify(expected);
for (const [language, outcomes] of Object.entries(runners)) {
	if (JSON.stringify(outcomes) !== canonical) {
		throw new Error(
			`${language} protocol behavior diverged from golden:\nexpected ${canonical}\nreceived ${JSON.stringify(outcomes)}`,
		);
	}
}

process.stdout.write(
	`protocol conformance OK: ${expected.length} golden cases × ${Object.keys(runners).length} languages\n`,
);
