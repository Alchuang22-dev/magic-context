/** Host identifier. Core code treats it as opaque and never branches on it. */
export type TranscriptHarness = string;

/** Canonical part categories exposed by a host-owned transcript view. */
export type TranscriptPartKind =
	| "text"
	| "thinking"
	| "tool_use"
	| "tool_result"
	| "image"
	| "file"
	| "structural"
	| "unknown";

/**
 * Mutable view over one host-native content part.
 *
 * Implementations remain owned by the host adapter. Core algorithms use this
 * narrow surface and never import a host SDK or round-trip the native object.
 */
export interface TranscriptPart {
	readonly kind: TranscriptPartKind;
	readonly id: string | undefined;
	getText(): string | undefined;
	setText(newText: string): boolean;
	setToolOutput(newText: string): boolean;
	getToolMetadata(): {
		toolName: string | undefined;
		inputByteSize: number;
		inputTokenCount: number;
	};
	getToolInput?(): Record<string, unknown> | null;
	setToolInput?(input: Record<string, unknown>): boolean;
	replaceWithSentinel(sentinelText: string): boolean;
	rawByteSize?(): number;
}

export interface TranscriptMessage {
	readonly info: {
		id?: string;
		role: string;
		sessionId?: string;
	};
	readonly parts: TranscriptPart[];
}

/**
 * A host-owned transcript projection for one transform pass.
 *
 * `commit` is a no-op for adapters that mutate their native objects directly.
 * Copy-on-write adapters use it to publish their rebuilt native message list.
 */
export interface Transcript {
	readonly messages: TranscriptMessage[];
	readonly harness: TranscriptHarness;
	commit(): void;
}

export const STRUCTURAL_SENTINEL_KIND: TranscriptPartKind = "structural";
