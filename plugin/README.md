# Agent Plugin Migration

This subtree contains the host-neutral Magic Context plugin migration. It is
kept physically and dependency-wise separate from the existing implementations
under `packages/plugin` (OpenCode) and `packages/pi-plugin` (Pi/OMP).

## Layout

- `core-plugin/` owns the host-neutral transcript, protocol, token-pressure,
  budget, and scheduling policy.
- `runtime/` implements the independent compose/observe data plane and the
  tool, lifecycle, cache-feedback, and event-trigger control plane. It owns
  durable session/project storage, memory deduplication, hybrid recall, and
  budgeted injection. It also owns Historian validation/publication,
  Dreamer/Sidekick scheduling, durable callback leases, retry, and attempt
  fencing.
- `adapter-kit/` owns the shared host execution chain: compose/observe,
  lifecycle, cache/tool feedback, context tools, and reverse callbacks.
- `opencode-plugin/` and `pi-plugin/` contain only native transcript codecs and
  ContextPlan materializers. Their published legacy entrypoints are not yet
  switched; see [MIGRATION.md](./MIGRATION.md).
- `hermes-plugin/` is a Hermes `ContextEngine` Adapter for that Interface.
  It executes runtime callbacks through the host-owned `ctx.llm` seam; it does
  not decide what auxiliary output is valid or when it becomes durable.

The domain vocabulary and ownership rules are recorded in
[CONTEXT.md](./CONTEXT.md).

## Isolation rules

- Code in this subtree must not import implementation files from the existing
  OpenCode or Pi packages.
- Existing host packages must not depend on this subtree during the migration.
- Shared behavior is captured as self-contained fixtures and Interface tests
  here; host wiring is added only through a new Adapter.
- Use the root `plugin:*` scripts to build and verify this subtree independently
  from the existing repository workflows.
