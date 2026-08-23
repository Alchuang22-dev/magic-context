#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const artifactRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
	throw new Error("usage: smoke-runtime.mjs ARTIFACT_DIRECTORY");
}
const manifest = JSON.parse(
	await readFile(resolve(artifactRoot, "runtime-manifest.json"), "utf8"),
);
const binary = resolve(artifactRoot, manifest.binary);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha256(await readFile(binary)) !== manifest.binarySha256) {
	throw new Error("runtime binary checksum does not match its manifest");
}

function run(args, input) {
	const result = spawnSync(binary, args, { encoding: "utf8", input });
	if (result.error || result.status !== 0) {
		throw new Error(
			`runtime smoke failed: ${result.error?.message ?? result.stderr ?? `status ${result.status}`}`,
		);
	}
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "");
}

const protocol = run(["--protocol-info"]);
if (
	protocol.protocolVersion !== manifest.protocolVersion ||
	protocol.idlSha256 !== manifest.idlSha256
) {
	throw new Error("runtime protocol identity does not match its release manifest");
}
const request = {
	method: "maintenance.poll",
	params: {
		protocolVersion: manifest.protocolVersion,
		pollId: "release-smoke",
		host: "release-smoke",
		sessionId: "release-smoke",
		polledAtMs: 0,
	},
};
const response = run(["--memory"], `${JSON.stringify(request)}\n`);
if (
	response.result?.protocolVersion !== manifest.protocolVersion ||
	response.result?.pollId !== "release-smoke" ||
	response.result?.sessionId !== "release-smoke"
) {
	throw new Error("runtime maintenance.poll response is not conformant");
}

const checksumLines = (
	await readFile(resolve(artifactRoot, "SHA256SUMS"), "utf8")
)
	.trim()
	.split(/\r?\n/);
for (const line of checksumLines) {
	const match = line.match(/^([a-f0-9]{64})  (.+)$/);
	if (!match || basename(match[2]) !== match[2]) {
		throw new Error(`invalid SHA256SUMS entry: ${line}`);
	}
	if (sha256(await readFile(resolve(artifactRoot, match[2]))) !== match[1]) {
		throw new Error(`checksum mismatch: ${match[2]}`);
	}
}

process.stdout.write(
	`runtime release smoke OK: ${manifest.target}, protocol v${manifest.protocolVersion}\n`,
);
