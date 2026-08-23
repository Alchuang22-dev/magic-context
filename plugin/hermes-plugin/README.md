# Magic Context for Hermes

This package is a thin Hermes adapter for the host-neutral Magic Context core
protocol. It registers a `magic-context` `ContextEngine` and does not import an
OpenCode or Pi implementation.

## Activation

Install this directory as a Hermes plugin and select the engine:

```yaml
context:
  engine: magic-context

compression:
  enabled: false
```

Set `MAGIC_CONTEXT_RUNTIME_COMMAND` to a command that accepts one JSON request
on stdin and prints one JSON response on stdout. The protocol supports
`context.compose`, `turn.observe`, `tool.execute`, `session.lifecycle`,
`cache.observe`, `tool.observe`, `maintenance.poll`, and
`host.callback.resolve`. `context.compose` returns the `ContextPlan` defined by
`@cortexkit/magic-context-core-plugin`.

The sibling `plugin/runtime` package provides that executable. After
`bun run plugin:build`, configure its built CLI:

```bash
export MAGIC_CONTEXT_RUNTIME_COMMAND="node /absolute/path/plugin/runtime/dist/cli.js"
```

When the runtime is absent or fails, the adapter leaves an in-budget request
unchanged. An over-budget request is reduced to a deterministic, tool-safe tail
instead of raising into Hermes' fail-open selection seam.

The Hermes bridge currently starts the command once per call; durable runtime
state makes those calls equivalent to the runtime's long-running NDJSON mode.
A future persistent bridge can reuse the same protocol without changing the
Hermes Adapter.

## Auxiliary execution

The runtime emits reverse callbacks for Historian, Dreamer, and Sidekick.
Hermes executes them through `ctx.llm` using the registered
`magic_context_historian`, `magic_context_dreamer`, and
`magic_context_sidekick` task slots, then returns text, parsed JSON, provider,
model, and token usage to the runtime. This keeps Hermes model routing, auth,
fallback, and timeout enforcement host-owned.

Historian and Dreamer run in the serialized completed-turn worker. Sidekick,
when enabled, completes before request materialization and triggers a fresh
compose so its result is visible to the active provider request. The active
session also runs a bounded 30-second maintenance poll to recover persisted
leases and due Dreamer work. The runtime rejects stale attempt results and
retries transient failures with a durable lease and attempt limit.

Settings live under `plugins.entries.magic-context.settings`:

- `historian_enabled`, `historian_threshold_percentage`,
  `historian_min_messages`, `historian_protected_tail_messages`, and
  `historian_timeout_ms`
- `dreamer_enabled`, `dreamer_interval_ms`, and `dreamer_timeout_ms`
- `sidekick_enabled` and `sidekick_timeout_ms`
- `auxiliary_max_attempts`

Sidekick defaults off; Historian and Dreamer default on. Provider/model choices
for each execution role remain configurable through Hermes' registered
auxiliary task slots.

## Hermes tool surface

Selecting the engine registers the `context_engine` toolset:

- `ctx_status`
- `ctx_search`
- `ctx_memory`
- `ctx_expand`
- `ctx_reduce`
- `ctx_note`

The Adapter gives every canonical content block a deterministic ID and
advertises `stablePartIds`, so runtime plans can replace, truncate, or drop an
individual text, thinking, tool-call, or tool-result block. Hermes messages are
deep-copied before materialization; persisted conversation history is never
mutated.

Hermes pre/post tool hooks feed `tool.observe`, provider usage feeds
`cache.observe`, and host transitions feed start/end/clone/reset/delete
lifecycle requests. Hosts that delete a session out of process must surface an
`on_session_finalize` hook with a delete/prune reason for the plugin to remove
its matching runtime state.

Hermes project identity is forwarded from `project_id`, `project_path`, `cwd`,
or `working_directory` session metadata. A historian integration may attach
`memory_candidates` to `on_turn_complete`; Hermes only translates that field,
while validation, persistence, deduplication, and recall stay in the runtime.

## Live provider test

The live test installs the plugin into an isolated temporary `HERMES_HOME`,
starts a real `AIAgent`, verifies provider-originated context tool calls, and
checks that no credential was written below the temporary home:

```bash
export MAGIC_CONTEXT_LIVE_API_KEY="..."
export MAGIC_CONTEXT_LIVE_BASE_URL="https://agentrouter.org/v1"
export MAGIC_CONTEXT_LIVE_MODEL="provider-model-id"
uv run --project /absolute/path/hermes-agent \
  python /absolute/path/plugin/hermes-plugin/tests/live_provider_e2e.py
```

The test never writes the API key to `config.yaml`; it passes the value directly
to the provider client and prints only a sanitized result summary.
