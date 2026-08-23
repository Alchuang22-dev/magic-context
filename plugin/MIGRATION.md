# Core-plugin migration status

The new implementation is isolated under `plugin/`. The original
`packages/plugin` (OpenCode) and `packages/pi-plugin` remain parity references
until their published entrypoints are switched to the thin adapters.

| Domain Module | Runtime-owned Implementation | Host Interface | Status |
| --- | --- | --- | --- |
| Tagging | stable allocation, composite tool identity, tag reduction/expand | `prefix_tag` / block mutation | migrated |
| Scheduler | pressure floor, cache TTL, budget partition, target selection | usage and context-limit facts | migrated |
| Storage | paired session/project stores, locks, atomic JSON writes | runtime transport only | migrated |
| Memory | validation, deduplication, hybrid recall, mutation, render budget | context tools and observations | migrated |
| Injection | history + memory + triggers + tags + Sidekick ordering | `ContextPlan.injections` and mutations | migrated |
| Auxiliary chain | Historian/Dreamer/Sidekick reverse callbacks | host LLM Adapter | migrated |
| Protocol | JSON IDL, generated Schema and TS/Python/Rust bindings | generated validation | migrated |
| Conformance | positive/negative wire golden and semantic Adapter golden | TS/Python/Rust + three hosts | migrated |
| Release | five runtime targets, Hermes bundles, checksums, npm/GitHub workflows | install/doctor/migrate | migrated |
| OpenCode Adapter | native message/part codec | shared controller | codec complete; hook cutover pending |
| Pi Adapter | native message/SessionEntry codec | shared controller | codec complete; hook cutover pending |
| Hermes Adapter | Python codec, ContextEngine hooks, `ctx.llm` translation | stdio runtime | active |

## Cutover rule

An old host entrypoint can be retired only after its black-box fixture suite is
replayed through the new Adapter Interface. No algorithm may be copied back
into an Adapter to make a fixture pass; missing behaviour must deepen the
Runtime Module instead.

The current cross-host golden proves canonical transcript equivalence for a
representative user/tool-call/tool-result arc. It does not by itself complete
the legacy OpenCode/Pi published-hook cutover; those two rows remain explicitly
pending until their full black-box suites run through the new Interface.
