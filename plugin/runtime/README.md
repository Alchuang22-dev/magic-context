# Magic Context Runtime

This package is the host-neutral runtime behind the agent-plugin protocol. Its
entire external Interface is two methods:

- `context.compose` accepts a canonical transcript and returns a validated
  `ContextPlan` after token-pressure, budget-partition, scheduling, protected
  tail, and bounded-reduction policy.
- `turn.observe` records a canonical completed turn idempotently and returns a
  revisioned receipt. Observed usage feeds the next compose decision.

The runtime never imports an agent SDK or an existing OpenCode/Pi
implementation. `MemoryRuntimeStateStore` supports embedding and tests;
`JsonDirectoryRuntimeStateStore` uses a per-session lock and atomic rename so
one-shot Hermes calls and long-running stdio calls share the same semantics.

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
- `MAGIC_CONTEXT_CACHE_TTL`
- `MAGIC_CONTEXT_MAX_OBSERVED_TURNS`
