import { randomUUID } from "node:crypto";

import {
	type AgentContextAdapter,
	type CacheFeedbackReceipt,
	type CanonicalMessage,
	CORE_PROTOCOL_VERSION,
	type ContextPlan,
	type ContextRuntimeResult,
	type ContextToolExecutionResult,
	type ContextToolName,
	type ContextUsageObservation,
	type HostCallbackFailure,
	type HostCallbackRequest,
	type HostCallbackSuccess,
	type SessionLifecycleAction,
	type SessionLifecycleReceipt,
	type ToolEventReceipt,
	type TurnObservationReceipt,
	validateContextPlan,
} from "@cortexkit/magic-context-core-plugin";
import type {
	MagicContextRuntime,
	RuntimeCallEnvelope,
} from "@cortexkit/magic-context-runtime";

const MAX_CALLBACK_CHAIN = 8;

export interface RuntimeCaller {
	handle(call: RuntimeCallEnvelope): Promise<ContextRuntimeResult>;
}

export interface AuxiliaryLlmAdapter {
	execute(
		callback: HostCallbackRequest,
	): Promise<HostCallbackSuccess | HostCallbackFailure>;
}

export interface ContextFlight {
	sessionId: string;
	budgetTokens: number;
	turnId?: string;
	projectId?: string;
	modelKey?: string;
	usage?: ContextUsageObservation;
}

export interface ObserveFlight extends ContextFlight {
	observationId?: string;
	interrupted?: boolean;
	failed?: boolean;
	exitReason?: string;
}

export interface RuntimeAgentControllerOptions<NativeMessages> {
	adapter: AgentContextAdapter<NativeMessages>;
	runtime: RuntimeCaller | MagicContextRuntime;
	llm?: AuxiliaryLlmAdapter;
	now?: () => number;
	id?: () => string;
}

/**
 * Shared host Adapter orchestration. Host packages provide only message codecs,
 * hook registration, usage facts, and an optional auxiliary-LLM Adapter.
 */
export class RuntimeAgentController<NativeMessages> {
	readonly adapter: AgentContextAdapter<NativeMessages>;
	readonly runtime: RuntimeCaller;
	readonly llm?: AuxiliaryLlmAdapter;
	readonly now: () => number;
	readonly id: () => string;

	constructor(options: RuntimeAgentControllerOptions<NativeMessages>) {
		this.adapter = options.adapter;
		this.runtime = options.runtime;
		this.llm = options.llm;
		this.now = options.now ?? Date.now;
		this.id = options.id ?? randomUUID;
	}

	async compose(
		messages: NativeMessages,
		flight: ContextFlight,
	): Promise<NativeMessages> {
		for (let pass = 0; pass < 4; pass += 1) {
			const request = {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: this.id(),
				host: this.adapter.host,
				sessionId: flight.sessionId,
				turnId: flight.turnId,
				projectId: flight.projectId,
				modelKey: flight.modelKey,
				budgetTokens: Math.max(0, Math.floor(flight.budgetTokens)),
				capabilities: this.adapter.capabilities,
				messages: this.adapter.snapshot(messages),
				usage: flight.usage,
			};
			const plan = (await this.runtime.handle({
				method: "context.compose",
				params: request,
			})) as ContextPlan;
			validateContextPlan(request, plan);
			if (plan.callbacks?.length) {
				await this.#dispatchCallbacks(plan.callbacks);
				continue;
			}
			return this.adapter.materialize(messages, plan);
		}
		throw new Error("context.compose callback chain did not converge");
	}

	async observe(
		messages: NativeMessages,
		flight: ObserveFlight,
	): Promise<TurnObservationReceipt> {
		const receipt = (await this.runtime.handle({
			method: "turn.observe",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				observationId: flight.observationId ?? this.id(),
				host: this.adapter.host,
				sessionId: flight.sessionId,
				turnId: flight.turnId,
				projectId: flight.projectId,
				modelKey: flight.modelKey,
				observedAtMs: this.now(),
				messages: this.adapter.snapshot(messages),
				usage: flight.usage,
				outcome: {
					interrupted: flight.interrupted ?? false,
					failed: flight.failed ?? false,
					exitReason: flight.exitReason,
				},
			},
		})) as TurnObservationReceipt;
		if (receipt.callbacks?.length)
			await this.#dispatchCallbacks(receipt.callbacks);
		return receipt;
	}

	async lifecycle(
		action: SessionLifecycleAction,
		flight: Pick<ContextFlight, "sessionId" | "projectId" | "modelKey"> & {
			targetSessionId?: string;
			reason?: string;
		},
	): Promise<SessionLifecycleReceipt> {
		return (await this.runtime.handle({
			method: "session.lifecycle",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: this.id(),
				host: this.adapter.host,
				sessionId: flight.sessionId,
				action,
				observedAtMs: this.now(),
				targetSessionId: flight.targetSessionId,
				projectId: flight.projectId,
				modelKey: flight.modelKey,
				reason: flight.reason,
			},
		})) as SessionLifecycleReceipt;
	}

	async cache(
		flight: Pick<ContextFlight, "sessionId" | "projectId" | "modelKey"> & {
			usage: ContextUsageObservation;
		},
	): Promise<CacheFeedbackReceipt> {
		return (await this.runtime.handle({
			method: "cache.observe",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: this.id(),
				host: this.adapter.host,
				sessionId: flight.sessionId,
				observedAtMs: this.now(),
				projectId: flight.projectId,
				modelKey: flight.modelKey,
				usage: flight.usage,
			},
		})) as CacheFeedbackReceipt;
	}

	async toolEvent(input: {
		sessionId: string;
		phase: "pre" | "post";
		toolName: string;
		arguments?: Record<string, unknown>;
		result?: unknown;
		status?: string;
		durationMs?: number;
		toolCallId?: string;
		turnId?: string;
	}): Promise<ToolEventReceipt> {
		return (await this.runtime.handle({
			method: "tool.observe",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				eventId: this.id(),
				host: this.adapter.host,
				sessionId: input.sessionId,
				observedAtMs: this.now(),
				phase: input.phase,
				toolName: input.toolName,
				arguments: input.arguments,
				result: input.result,
				status: input.status,
				durationMs: input.durationMs,
				toolCallId: input.toolCallId,
				turnId: input.turnId,
			},
		})) as ToolEventReceipt;
	}

	async executeTool(
		toolName: ContextToolName,
		argumentsValue: Record<string, unknown>,
		messages: NativeMessages,
		flight: Pick<ContextFlight, "sessionId" | "projectId" | "modelKey">,
	): Promise<ContextToolExecutionResult> {
		return (await this.runtime.handle({
			method: "tool.execute",
			params: {
				protocolVersion: CORE_PROTOCOL_VERSION,
				requestId: this.id(),
				host: this.adapter.host,
				sessionId: flight.sessionId,
				projectId: flight.projectId,
				modelKey: flight.modelKey,
				toolName,
				arguments: argumentsValue,
				messages: this.adapter.snapshot(messages),
				invokedAtMs: this.now(),
			},
		})) as ContextToolExecutionResult;
	}

	async #dispatchCallbacks(initial: HostCallbackRequest[]): Promise<void> {
		const queue = [...initial];
		const seen = new Set<string>();
		let completed = 0;
		while (queue.length > 0 && completed < MAX_CALLBACK_CHAIN) {
			const callback = queue.shift();
			if (!callback) break;
			const fence = `${callback.callbackId}:${callback.attempt}`;
			if (seen.has(fence)) continue;
			seen.add(fence);
			let outcome: HostCallbackSuccess | HostCallbackFailure;
			if (callback.deadlineAtMs <= this.now()) {
				outcome = {
					status: "timed_out",
					errorType: "CallbackDeadlineExceeded",
					message: "callback deadline elapsed before host execution",
				};
			} else if (!this.llm) {
				outcome = {
					status: "failed",
					errorType: "AuxiliaryLlmUnavailable",
					message: "host auxiliary LLM Adapter is unavailable",
				};
			} else {
				try {
					outcome = await this.llm.execute(callback);
				} catch (error) {
					outcome = {
						status: "failed",
						errorType:
							error instanceof Error ? error.name : "HostCallbackError",
						message:
							error instanceof Error
								? error.message.slice(0, 1_000)
								: String(error).slice(0, 1_000),
					};
				}
			}
			const receipt = (await this.runtime.handle({
				method: "host.callback.resolve",
				params: {
					protocolVersion: CORE_PROTOCOL_VERSION,
					resolutionId: this.id(),
					host: this.adapter.host,
					sessionId: callback.sessionId,
					callbackId: callback.callbackId,
					attempt: callback.attempt,
					resolvedAtMs: this.now(),
					outcome,
				},
			})) as { callbacks?: HostCallbackRequest[] };
			if (receipt.callbacks?.length) queue.push(...receipt.callbacks);
			completed += 1;
		}
		if (queue.length > 0)
			throw new Error("host callback chain exceeded safety limit");
	}
}

export type { CanonicalMessage };
