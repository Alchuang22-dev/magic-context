import { describe, expect, test } from "bun:test";

import { RuntimeAgentController } from "@cortexkit/magic-context-adapter-kit";
import {
	MagicContextRuntime,
	RuntimeStorage,
} from "@cortexkit/magic-context-runtime";

import { PiContextAdapter, type PiMessageBatch } from "./adapter";

describe("PiContextAdapter", () => {
	test("uses SessionEntry ids and applies the same runtime tag plan", async () => {
		const batch: PiMessageBatch = {
			entryIds: ["entry-user", "entry-assistant", "entry-result"],
			messages: [
				{ role: "user", content: "inspect this" },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call", name: "read", arguments: {} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "call",
					content: [{ type: "text", text: "contents" }],
				},
			],
		};
		const controller = new RuntimeAgentController({
			adapter: new PiContextAdapter(),
			runtime: new MagicContextRuntime({ storage: RuntimeStorage.inMemory() }),
		});
		const output = await controller.compose(batch, {
			sessionId: "s",
			budgetTokens: 32_000,
		});

		expect(output.messages[0].content).toBe("§1§ inspect this");
		expect(
			(output.messages[2].content as Array<Record<string, unknown>>)[0].text,
		).toBe("§2§ contents");
		expect(output.entryIds).toEqual(batch.entryIds);
	});
});
