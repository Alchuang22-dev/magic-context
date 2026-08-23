# Magic Context Runtime

This package is the host-neutral runtime behind the agent-plugin protocol. Its
external Interface has a data plane and a control plane:

- `context.compose` accepts a canonical transcript and returns a validated
  `ContextPlan` after token-pressure, budget-partition, scheduling, protected
  tail, and bounded-reduction policy.
- `turn.observe` records a canonical completed turn idempotently and returns a
  revisioned receipt. Observed usage feeds the next compose decision and
  optional `memoryCandidates` are persisted idempotently.
- `tool.execute` implements `ctx_search`, `ctx_memory`, `ctx_expand`,
  `ctx_reduce`, and `ctx_note` without importing a host SDK.
- `session.lifecycle` owns start/end/clone/reset/delete state transitions.
- `cache.observe` records cache-read/cache-write feedback, while
  `tool.observe` records pre/post tool events and schedules automatic nudges.
- `maintenance.poll` leases due or timed-out Historian/Dreamer work.
- `host.callback.resolve` accepts fenced auxiliary-LLM results from a host
  Adapter. The runtime validates and publishes those results before advancing
  any history cursor or memory schedule.

Internally, the runtime presents deep Tagging, Scheduler, Storage, Memory, and
Injection Modules. `MagicContextRuntime` orchestrates those Interfaces; no
host Adapter participates in their policy.

## Stable tags

The Tagging Module assigns monotonic `§N§` identities to text/file blocks and
to tools by composite `(owner message, call id)` identity. A reused bare call
id therefore cannot inherit an older tool's reduction state. `ctx_reduce`
accepts tag tokens for block-level persistent mutation, while `ctx_expand`
accepts `tag=<N>` and reads the retained raw source. Hosts only materialize the
runtime's `prefix_tag` or `drop` mutation.

## Historian, Dreamer, and Sidekick

Auxiliary inference uses a reverse-callback Interface: the runtime emits an
`auxiliary_llm` callback with a Hermes-style task key, attempt number, and
deadline; the host invokes its own trusted LLM seam and resolves the callback.
No provider SDK, model routing, or credential enters the runtime.

- Historian is triggered by input-side token pressure and a minimum eligible
  source range. It excludes a protected raw tail. Output must contain ordered,
  contiguous, full-coverage p1-p4 compartments plus valid five-category memory
  candidates. Only a successfully validated and durably published result drops
  source ordinals and advances `historianCursorOrdinal`.
- Dreamer is scheduled after a successful Historian publication and when its
  durable-memory interval is due. It validates candidate memories and archive
  IDs before applying either mutation.
- Sidekick is an optional blocking pre-compose recall step. Useful output is
  stripped of `<think>` blocks and queued as a one-shot tail injection;
  `No relevant memories found.` is treated as an empty result.

Jobs, leases, attempt counters, deadlines, and completion fences live in the
session store. Expired leases are retried with exponential backoff up to the
configured maximum. A late result from an older attempt is rejected, and
session cloning copies published compartments but never copies in-flight
callbacks.

The runtime never imports an agent SDK or an existing OpenCode/Pi
implementation. Session and project-memory stores each expose a narrow
persistence Interface with in-memory and durable JSON Adapters. The JSON
Adapters share per-document locks and atomic rename, so one-shot Hermes calls
and long-running stdio calls have the same semantics.

## Memory and recall

`turn.observe` accepts already-extracted facts rather than treating arbitrary
transcript text as durable memory. The runtime owns the remaining pipeline:

- the five-category memory taxonomy and strict candidate validation;
- whitespace/case normalization and hash-compatible exact deduplication;
- retry-safe `seenCount`, provenance, expiry, status, and verification fields;
- BM25 lexical recall fused with cosine similarity using the original
  `0.7 / 0.3` weighting and `0.8` single-source penalty;
- deterministic category rendering, XML escaping, visible-memory exclusion,
  and hard memory-budget enforcement;
- stable-prefix injection when supported, with fingerprint-aware cache busts.

The default embedding Adapter is a deterministic dependency-free feature hash.
Embedded runtimes can supply another `EmbeddingAdapter` without changing the
Memory Module or host Adapter. Project memory is keyed by `projectId`; when a
host cannot provide one, the runtime deliberately falls back to a session-local
key to prevent cross-project leakage.

## Context tools and triggers

- `ctx_search` performs hybrid memory recall plus lexical message/note search.
- `ctx_memory` writes, updates, archives, merges, gets, and lists project
  memories.
- `ctx_expand` reads by tag or ordinal from the retained raw transcript even
  after `ctx_reduce` removes content from provider context.
- `ctx_note` stores session notes and supports `tool:<name>` surface conditions.
- Large successful tool results, ready smart notes, and cache pressure at or
  above 85% enqueue one-shot `tail_nudge` injections for the next compose.

All control-plane requests carry caller-provided idempotency IDs. Durable JSON
state includes recent receipts and event IDs so retrying a one-shot Adapter
does not duplicate mutations or feedback.

## Command

Build the isolated subtree and point an Adapter at the executable:

```bash
bun run plugin:build
export MAGIC_CONTEXT_RUNTIME_COMMAND="node /absolute/path/plugin/runtime/dist/cli.js"
```

The command reads one JSON object or an NDJSON stream from stdin and writes one
response for every input line. State defaults to the platform state directory;
override it with `MAGIC_CONTEXT_RUNTIME_STATE_DIR` or `--state-dir PATH`. Use
`--memory` only for a single long-running process or diagnostics.

Policy overrides are available through:

- `MAGIC_CONTEXT_EXECUTE_THRESHOLD_PERCENTAGE`
- `MAGIC_CONTEXT_HISTORY_BUDGET_PERCENTAGE`
- `MAGIC_CONTEXT_MEMORY_BUDGET_TOKENS`
- `MAGIC_CONTEXT_MEMORY_BUDGET_PERCENTAGE`
- `MAGIC_CONTEXT_CACHE_TTL`
- `MAGIC_CONTEXT_MAX_OBSERVED_TURNS`
