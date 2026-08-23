import { describe, expect, test } from "bun:test";

import type { CanonicalMessage } from "@cortexkit/magic-context-core-plugin";
import { OpenCodeContextAdapter } from "../opencode-plugin/src/adapter";
import { PiContextAdapter } from "../pi-plugin/src/adapter";
import golden from "./adapter-golden.json";

function semanticBlocks(messages: CanonicalMessage[]) {
	return messages.flatMap((message) =>
		message.content.flatMap((block) => {
			if (block.kind === "text") {
				return block.text
					? [{ role: message.role, kind: block.kind, value: block.text }]
					: [];
			}
			if (block.kind === "tool_call") {
				return [
					{
						role: "assistant",
						kind: block.kind,
						callId: block.callId,
						name: block.name,
						value: block.input,
					},
				];
			}
			if (block.kind === "tool_result") {
				return [
					{
						role: "tool",
						kind: block.kind,
						callId: block.callId,
						name: block.name,
						value: block.output,
					},
				];
			}
			return [];
		}),
	);
}

describe("Agent Adapter equivalence", () => {
	test("OpenCode and Pi produce the same canonical tool arc", () => {
		const openCode = new OpenCodeContextAdapter().snapshot([
			{
				info: { id: "user", role: "user" },
				parts: [{ type: "text", text: "inspect this" }],
			},
			{
				info: { id: "assistant", role: "assistant" },
				parts: [
					{
						type: "tool",
						callID: "call-1",
						tool: "read",
						state: {
							input: { path: "a.txt" },
							output: "contents",
						},
					},
				],
			},
		]);
		const pi = new PiContextAdapter().snapshot({
			entryIds: ["user", "assistant", "result"],
			messages: [
				{ role: "user", content: "inspect this" },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "a.txt" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: "contents",
				},
			],
		});

		expect(semanticBlocks(openCode)).toEqual(golden.semanticBlocks);
		expect(semanticBlocks(pi)).toEqual(golden.semanticBlocks);
	});
});
