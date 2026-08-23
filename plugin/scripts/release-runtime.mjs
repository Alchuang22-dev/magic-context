#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(pluginRoot, "..");
const supportedTargets = new Map([
	["linux-x64", "bun-linux-x64"],
	["linux-arm64", "bun-linux-arm64"],
	["darwin-x64", "bun-darwin-x64"],
	["darwin-arm64", "bun-darwin-arm64"],
	["windows-x64", "bun-windows-x64"],
]);

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function nativeTarget() {
	const platform = process.platform === "win32" ? "windows" : process.platform;
	return `${platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		stdio: "inherit",
		env: process.env,
		...options,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} failed: ${result.error?.message ?? `status ${result.status}`}`,
		);
	}
}

async function sha256(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

const target = argument("--target", nativeTarget());
const bunTarget = supportedTargets.get(target);
if (!bunTarget) {
	throw new Error(
		`unsupported target ${target}; expected ${[...supportedTargets.keys()].join(", ")}`,
	);
}
const outputRoot = resolve(argument("--output", join(pluginRoot, "release")));
if (dirname(outputRoot) === outputRoot) {
	throw new Error("release output must not be a filesystem root");
}
const runtimePackage = JSON.parse(
	await readFile(join(pluginRoot, "runtime/package.json"), "utf8"),
);
const protocolManifest = JSON.parse(
	await readFile(join(pluginRoot, "protocol/generated/manifest.json"), "utf8"),
);
const artifactRoot = join(outputRoot, target);
const binaryName =
	target === "windows-x64"
		? "magic-context-runtime.exe"
		: "magic-context-runtime";
const binaryPath = join(artifactRoot, binaryName);
await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });

run("bun", [
	"build",
	join(pluginRoot, "runtime/src/cli.ts"),
	"--compile",
	"--minify",
	`--target=${bunTarget}`,
	`--outfile=${binaryPath}`,
]);
if (target !== "windows-x64") await chmod(binaryPath, 0o755);

const binarySha256 = await sha256(binaryPath);
const runtimeManifest = {
	name: "magic-context-runtime",
	version: runtimePackage.version,
	target,
	protocolVersion: protocolManifest.protocolVersion,
	idlSha256: protocolManifest.idlSha256,
	schemaSha256: protocolManifest.schemaSha256,
	binary: binaryName,
	binarySha256,
};
await writeFile(
	join(artifactRoot, "runtime-manifest.json"),
	`${JSON.stringify(runtimeManifest, null, 2)}\n`,
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "magic-context-release-"));
try {
	const bundle = join(temporaryRoot, "magic-context");
	await cp(join(pluginRoot, "hermes-plugin"), bundle, {
		recursive: true,
		filter(source) {
			const relative = source.slice(join(pluginRoot, "hermes-plugin").length);
			return !relative
				.split(sep)
				.some((part) =>
					["__pycache__", "tests", ".pytest_cache", "bin"].includes(part),
				);
		},
	});
	await mkdir(join(bundle, "bin"), { recursive: true });
	await cp(binaryPath, join(bundle, "bin", binaryName));
	if (target !== "windows-x64") {
		await chmod(join(bundle, "bin", binaryName), 0o755);
	}
	await cp(
		join(pluginRoot, "protocol/schema/magic-context.schema.json"),
		join(bundle, "magic-context.schema.json"),
	);
	await cp(
		join(pluginRoot, "protocol/generated/manifest.json"),
		join(bundle, "protocol-manifest.json"),
	);
	await writeFile(
		join(bundle, "runtime-manifest.json"),
		`${JSON.stringify(runtimeManifest, null, 2)}\n`,
	);
	await cp(join(repositoryRoot, "LICENSE"), join(bundle, "LICENSE"));
	const archiveName = `magic-context-hermes-${runtimePackage.version}-${target}.tar.gz`;
	const archivePath = join(artifactRoot, archiveName);
	run("tar", ["-czf", archivePath, "-C", temporaryRoot, basename(bundle)]);
	const archiveSha256 = await sha256(archivePath);
	await writeFile(
		join(artifactRoot, "SHA256SUMS"),
		`${binarySha256}  ${binaryName}\n${archiveSha256}  ${archiveName}\n`,
	);
	const files = await readdir(artifactRoot);
	process.stdout.write(
		`${JSON.stringify({ ...runtimeManifest, archive: archiveName, files })}\n`,
	);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
