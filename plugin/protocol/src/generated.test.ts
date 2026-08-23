import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	CORE_PROTOCOL_VERSION,
	PROTOCOL_IDL_SHA256,
	RUNTIME_METHODS,
	validateRuntimeCall,
} from "./generated";

describe("generated protocol", () => {
	test("binds the schema and language output to one IDL checksum", () => {
		const root = join(import.meta.dir, "..");
		const schema = readFileSync(join(root, "schema/magic-context.schema.json"));
		const manifest = JSON.parse(
			readFileSync(join(root, "generated/manifest.json"), "utf8"),
		);

		expect(CORE_PROTOCOL_VERSION).toBe(manifest.protocolVersion);
		expect(PROTOCOL_IDL_SHA256).toBe(manifest.idlSha256);
		expect(createHash("sha256").update(schema).digest("hex")).toBe(
			manifest.schemaSha256,
		);
		expect(Object.keys(RUNTIME_METHODS)).toHaveLength(8);
	});

	test("rejects unknown methods and unknown request fields", () => {
		expect(validateRuntimeCall({ method: "unknown", params: {} })).toBe(false);
		expect(
			validateRuntimeCall({
				method: "maintenance.poll",
				params: {
					protocolVersion: 1,
					pollId: "poll",
					host: "test",
					sessionId: "session",
					polledAtMs: 0,
					unknown: true,
				},
			}),
		).toBe(false);
	});
});
