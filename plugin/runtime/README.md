# Magic Context Runtime

This package is the host-neutral runtime behind the agent-plugin protocol. Its
entire external Interface is two methods:

- `context.compose` accepts a canonical transcript and returns a validated
  `ContextPlan` after token-pressure, budget-partition, scheduling, protected
  tail, and bounded-reduction policy.
- `turn.observe` records a canonical completed turn idempotently and returns a
  revisioned receipt. Observed usage feeds the next compose decision and
  optional `memoryCandidates` are persisted idempotently.

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
