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

When the runtime is absent or fails, the adapter leaves an in-budget request
unchanged. An over-budget request is reduced to a deterministic, tool-safe tail
instead of raising into Hermes' fail-open selection seam.

The one-shot command bridge is an intentionally small migration seam. It will
be replaced by the long-running `mc-runtime` transport once the Rust module is
detached from its current `subc`-only transport.
