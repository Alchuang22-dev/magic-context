# Agent Plugin Migration

This subtree contains the host-neutral Magic Context plugin migration. It is
kept physically and dependency-wise separate from the existing implementations
under `packages/plugin` (OpenCode) and `packages/pi-plugin` (Pi/OMP).

## Layout

- `core-plugin/` owns the host-neutral transcript, protocol, token-pressure,
  budget, and scheduling policy.
- `runtime/` implements the independent `context.compose` / `turn.observe`
  process, durable session and project-memory storage, memory deduplication,
  hybrid recall, and budgeted injection.
- `hermes-plugin/` is a Hermes `ContextEngine` Adapter for that Interface.

## Isolation rules

- Code in this subtree must not import implementation files from the existing
  OpenCode or Pi packages.
- Existing host packages must not depend on this subtree during the migration.
- Shared behavior is captured as self-contained fixtures and Interface tests
  here; host wiring is added only through a new Adapter.
- Use the root `plugin:*` scripts to build and verify this subtree independently
  from the existing repository workflows.
