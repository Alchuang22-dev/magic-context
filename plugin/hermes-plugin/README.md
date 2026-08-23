# Magic Context for Hermes

This package is a thin Hermes adapter for the host-neutral Magic Context core
protocol. It registers a `magic-context` `ContextEngine` and does not import an
OpenCode or Pi implementation.

## Install and activate

Each GitHub release provides a platform archive. Extract it, then install the
bundle and packaged runtime atomically into an isolated or normal Hermes home:

```bash
tar -xzf magic-context-hermes-0.1.0-darwin-arm64.tar.gz
python3 magic-context/management.py install magic-context --hermes-home ~/.hermes
python3 ~/.hermes/plugins/magic-context/management.py doctor
```

Once the plugin is enabled, Hermes also exposes the same management Interface
as `hermes magic-context doctor`, `hermes magic-context migrate`, and
`hermes magic-context install`. The direct Python entrypoint remains available
for first installation, before Hermes can discover the plugin.

Select the engine:

Install this directory as a Hermes plugin and select the engine:

```yaml
context:
  engine: magic-context

compression:
  enabled: false
```

The Adapter automatically discovers `bin/magic-context-runtime` from a release
bundle. `MAGIC_CONTEXT_RUNTIME_COMMAND` remains an override for development or
an externally managed process; it must accept one JSON request on stdin and
print one JSON response on stdout. The protocol supports
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

The Hermes bridge starts the command once per call; durable runtime state makes
those calls equivalent to the runtime's long-running NDJSON mode without
placing policy or persistence inside the Adapter.

## Doctor and migration

`doctor` verifies the generated binding and Schema hashes against the protocol
manifest, verifies the packaged binary checksum/identity, performs a real
`maintenance.poll` subprocess round trip, checks the state directory, and
invokes Hermes Plugin Doctor when Hermes is importable.

```bash
hermes magic-context doctor --state-dir ~/.local/state/magic-context/runtime-v1
hermes magic-context migrate /path/to/legacy/runtime-v1 --dry-run
hermes magic-context migrate /path/to/context.db --force
```

Migration accepts current schema-v1 JSON directories and the legacy SQLite
`memories` table. Memory identity, category, lifecycle and provenance are
preserved. Host-bound transcript tags/compartments are intentionally not
imported because their message/block identities cannot be made portable.

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
