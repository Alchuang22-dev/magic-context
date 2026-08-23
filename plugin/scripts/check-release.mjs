#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function json(path) {
	return JSON.parse(await readFile(resolve(pluginRoot, path), "utf8"));
}

const protocolPackage = await json("protocol/package.json");
const corePackage = await json("core-plugin/package.json");
const runtimePackage = await json("runtime/package.json");
const protocolManifest = await json("protocol/generated/manifest.json");
const idlBytes = await readFile(resolve(pluginRoot, "protocol/idl/magic-context.json"));
const schemaBytes = await readFile(
	resolve(pluginRoot, "protocol/schema/magic-context.schema.json"),
);
const pluginYaml = await readFile(
	resolve(pluginRoot, "hermes-plugin/plugin.yaml"),
	"utf8",
);
const pluginVersion = pluginYaml.match(/^version:\s*["']?([^\s"']+)/m)?.[1];

const versions = new Set([
	protocolPackage.version,
	corePackage.version,
	runtimePackage.version,
	pluginVersion,
]);
if (versions.size !== 1) {
	throw new Error(`release versions diverge: ${[...versions].join(", ")}`);
}
if (
	corePackage.dependencies?.[protocolPackage.name] !== protocolPackage.version ||
	runtimePackage.dependencies?.[corePackage.name] !== corePackage.version
) {
	throw new Error("public package dependencies must use the matching release version");
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
	digest(idlBytes) !== protocolManifest.idlSha256 ||
	digest(schemaBytes) !== protocolManifest.schemaSha256
) {
	throw new Error("protocol manifest hashes do not match the committed IDL/schema");
}
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "";
if (tag && tag !== `core-plugin-v${runtimePackage.version}`) {
	throw new Error(
		`release tag ${tag} does not match package version ${runtimePackage.version}`,
	);
}

process.stdout.write(
	`release contract OK: v${runtimePackage.version}, protocol v${protocolManifest.protocolVersion}\n`,
);
