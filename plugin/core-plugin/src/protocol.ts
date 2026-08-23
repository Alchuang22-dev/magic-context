import type { AgentCapabilities } from "@cortexkit/magic-context-protocol";

export * from "@cortexkit/magic-context-protocol";
export * from "./protocol-validation";

export const CONSERVATIVE_CAPABILITIES: Readonly<AgentCapabilities> =
	Object.freeze({
		preRequestTransform: true,
		stableMessageIds: false,
		stablePartIds: false,
		usageObservation: false,
		auxiliaryLlm: false,
		toolRegistration: false,
		toolEvents: false,
		requestBlocking: false,
		systemSuffixInjection: false,
		promptCacheFacts: false,
		blockIndexMutations: false,
	});

export function resolveCapabilities(
	advertised: Partial<AgentCapabilities> = {},
): AgentCapabilities {
	return { ...CONSERVATIVE_CAPABILITIES, ...advertised };
}
