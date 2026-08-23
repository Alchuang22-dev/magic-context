import { describe, expect, test } from "bun:test";

import { RuntimeAgentController } from "@cortexkit/magic-context-adapter-kit";
import {
	MagicContextRuntime,
	RuntimeStorage,
} from "@cortexkit/magic-context-runtime";

import { OpenCodeContextAdapter, type OpenCodeMessages } from "./adapter";

describe("OpenCodeContextAdapter", () => {
	test("materializes runtime-owned tags and preserves native tool structure", async () => {
		const messages: OpenCodeMessages = [
			{
				info: { id: "u1", role: "user", sessionID: "s" },
				parts: [{ type: "text", text: "inspect this" }],
			},
			{
				info: { id: "a1", role: "assistant", sessionID: "s" },
				parts: [
					{
						type: "tool",
						callID: "call",
						tool: "read",
						state: { input: { path: "a" }, output: "contents" },
					},
				],
			},
		];
		const controller = new RuntimeAgentController({
			adapter: new OpenCodeContextAdapter(),
			runtime: new MagicContextRuntime({ storage: RuntimeStorage.inMemory() }),
		});
		const output = await controller.compose(messages, {
			sessionId: "s",
			budgetTokens: 32_000,
		});

		expect(output[0].parts[0].text).toBe("§1§ inspect this");
		expect((output[1].parts[0].state as Record<string, unknown>).output).toBe(
			"§2§ contents",
		);
		expect(output[1].parts[0].callID).toBe("call");
	});
});
