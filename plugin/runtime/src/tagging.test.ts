import { describe, expect, test } from "bun:test";

import {
	CORE_PROTOCOL_VERSION,
	type ComposeContextRequest,
	resolveCapabilities,
} from "@cortexkit/magic-context-core-plugin";

import { MemoryRuntimeStateStore } from "./state-store";
import { prefixTag, RuntimeTagging, stripTagPrefix } from "./tagging";

function request(
	messages: ComposeContextRequest["messages"],
): ComposeContextRequest {
	return {
		protocolVersion: CORE_PROTOCOL_VERSION,
		requestId: crypto.randomUUID(),
		host: "test",
		sessionId: "session",
		budgetTokens: 32_000,
		capabilities: resolveCapabilities({
			stableMessageIds: true,
			stablePartIds: true,
			blockIndexMutations: true,
		}),
		messages,
	};
}

describe("RuntimeTagging", () => {
	test("allocates stable tags and emits request-local prefix mutations", async () => {
		const store = new MemoryRuntimeStateStore();
		const tagging = new RuntimeTagging(store, () => 10);
		const input = request([
			{
				id: "user-1",
				ordinal: 1,
				role: "user",
				content: [{ id: "user-1:text", kind: "text", text: "hello" }],
			},
		]);
		const first = await tagging.synchronize(input);
		const second = await tagging.synchronize({ ...input, requestId: "retry" });

		expect(first.mutations).toEqual([
			{
				target: { messageId: "user-1", blockId: "user-1:text" },
				operation: "prefix_tag",
				content: "§1§",
			},
		]);
		expect(second.mutations).toEqual(first.mutations);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(
			(await store.readSession({ host: "test", sessionId: "session" })).tags,
		).toMatchObject({ nextTagNumber: 2, records: [{ tagNumber: 1 }] });
	});

	test("uses composite tool identity when a call id is reused", async () => {
		const store = new MemoryRuntimeStateStore();
		const tagging = new RuntimeTagging(store, () => 10);
		const result = await tagging.synchronize(
			request([
				{
					id: "assistant-1",
					ordinal: 1,
					role: "assistant",
					content: [
						{
							id: "call-1",
							kind: "tool_call",
							callId: "reused",
							name: "read",
							input: {},
						},
					],
				},
				{
					id: "result-1",
					ordinal: 2,
					role: "tool",
					content: [
						{
							id: "result-1:block",
							kind: "tool_result",
							callId: "reused",
							output: "one",
						},
					],
				},
				{
					id: "assistant-2",
					ordinal: 3,
					role: "assistant",
					content: [
						{
							id: "call-2",
							kind: "tool_call",
							callId: "reused",
							name: "read",
							input: {},
						},
					],
				},
				{
					id: "result-2",
					ordinal: 4,
					role: "tool",
					content: [
						{
							id: "result-2:block",
							kind: "tool_result",
							callId: "reused",
							output: "two",
						},
					],
				},
			]),
		);

		expect(result.mutations.map((mutation) => mutation.content)).toEqual([
			"§1§",
			"§2§",
		]);
		const records = await tagging.records({
			host: "test",
			sessionId: "session",
		});
		expect(records.map((record) => record.ownerMessageId)).toEqual([
			"assistant-1",
			"assistant-2",
		]);
	});

	test("normalizes complete, malformed, and dangling leading tag notation", () => {
		expect(stripTagPrefix("§1§ §2§ hello")).toBe("hello");
		expect(stripTagPrefix('§3">§3§ hello')).toBe("hello");
		expect(prefixTag(4, "§9$ hello")).toBe("§4§ hello");
	});
});
