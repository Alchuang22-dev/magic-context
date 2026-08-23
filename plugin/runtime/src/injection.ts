import { createHash } from "node:crypto";

import type {
	CanonicalMessage,
	ComposeContextRequest,
	HostCallbackRequest,
} from "@cortexkit/magic-context-core-plugin";

import type { RuntimeAuxiliaryCoordinator } from "./auxiliary";
import type {
	RuntimeMemoryInjection,
	RuntimeTaggingPlan,
	RuntimeTriggerInjection,
} from "./compose";
import { memoryProjectKey, type RuntimeMemory } from "./memory";
import {
	deriveMemoryBudgetTokens,
	type RuntimePolicyConfig,
} from "./scheduler";
import type { RuntimeSessionState, RuntimeStateStore } from "./state-store";
import type { RuntimeTagging } from "./tagging";

function latestUserQuery(messages: readonly CanonicalMessage[]): string {
	const latest = [...messages]
		.reverse()
		.find((message) => message.role === "user");
	if (!latest) return "";
	return latest.content
		.map((block) => {
			if (block.kind === "text" || block.kind === "thinking") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function visibleMemoryIds(messages: readonly CanonicalMessage[]): number[] {
	const ids = new Set<number>();
	for (const message of messages) {
		for (const block of message.content) {
			if (
				(block.kind !== "text" && block.kind !== "thinking") ||
				!block.text.includes("<project-memory>")
			) {
				continue;
			}
			for (const match of block.text.matchAll(/^#(\d+):/gm)) {
				ids.add(Number(match[1]));
			}
		}
	}
	return [...ids];
}

export function renderTriggerInjection(
	state: RuntimeSessionState,
): RuntimeTriggerInjection | undefined {
	if (state.pendingTriggers.length === 0) return undefined;
	const triggers = state.pendingTriggers.slice(0, 4);
	const content = `<magic-context-triggers>\n${triggers
		.map((trigger) => `- ${trigger.content}`)
		.join("\n")}\n</magic-context-triggers>`;
	return {
		content,
		epoch: state.revision,
		fingerprint: createHash("sha256").update(content).digest("hex"),
		estimatedTokens: Math.max(
			1,
			Math.ceil(Buffer.byteLength(content, "utf8") / 3),
		),
		triggerIds: triggers.map((trigger) => trigger.id),
	};
}

export interface RuntimeInjectionBundle {
	callbacks: HostCallbackRequest[];
	knowledge?: RuntimeMemoryInjection;
	triggers?: RuntimeTriggerInjection;
	tagging: RuntimeTaggingPlan;
}

/**
 * Deep Injection Module: recall, history composition, trigger rendering, and
 * stable tag planning share one ordering contract and one test surface.
 */
export class RuntimeInjection {
	constructor(
		readonly store: RuntimeStateStore,
		readonly memory: RuntimeMemory,
		readonly auxiliary: RuntimeAuxiliaryCoordinator,
		readonly tagging: RuntimeTagging,
		readonly policy: RuntimePolicyConfig,
		readonly now: () => number = Date.now,
	) {}

	async prepare(
		request: ComposeContextRequest,
	): Promise<RuntimeInjectionBundle> {
		const tagging = await this.tagging.synchronize(request);
		const callbacks = await this.auxiliary.beforeCompose(request);
		const identity = { host: request.host, sessionId: request.sessionId };
		const state = await this.store.readSession(identity);
		const memoryBudget = deriveMemoryBudgetTokens(request, state, this.policy);
		const recalled = await this.memory.recallAndRender({
			projectKey: memoryProjectKey(request),
			query: latestUserQuery(request.messages),
			budgetTokens: memoryBudget,
			excludeIds: visibleMemoryIds(request.messages),
			nowMs: this.now(),
		});
		const contextLimit = Math.max(
			0,
			request.budgetTokens,
			request.usage?.contextLimitTokens ?? 0,
		);
		return {
			callbacks,
			knowledge: this.auxiliary.combineKnowledge(
				recalled,
				state,
				Math.floor(contextLimit * this.policy.historyBudgetPercentage),
			),
			triggers: renderTriggerInjection(state),
			tagging,
		};
	}
}
