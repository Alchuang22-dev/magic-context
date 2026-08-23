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
on stdin and prints one JSON response on stdout. The initial protocol supports
`context.compose` and `turn.observe`. `context.compose` returns the
`ContextPlan` defined by `@cortexkit/magic-context-core-plugin`.

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
