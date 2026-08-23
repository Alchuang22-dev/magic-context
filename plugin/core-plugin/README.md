# Magic Context Core Plugin

This package is the host-neutral core for Magic Context integrations. It
contains no OpenCode, Pi, Hermes, provider SDK, transport, or storage imports.

The protocol deliberately separates two concerns:

- the runtime decides what context to retain, reduce, recall, and inject;
- the host adapter decides how that plan is represented on its provider wire.

New agent integrations should implement `AgentContextAdapter` and exchange a
`ComposeContextRequest` / `ContextPlan` with the Magic Context runtime. They
must not import implementation files from another host plugin.

Completed turns cross the same seam as canonical `ObserveTurnRequest` values.
`observationId` is idempotent within a host session, allowing one-shot and
long-running runtime transports to share the same state semantics. A host or
historian may attach validated `memoryCandidates`; storage and recall remain
runtime-owned.

The same protocol declares host-neutral control-plane calls for context tools,
session lifecycle, cache feedback, and tool events. `ContextPlan` validation
permits block targets only when an Adapter advertises `stablePartIds` and the
referenced block exists in the canonical request.

Auxiliary execution crosses the Interface as runtime-originated
`HostCallbackRequest` values. A host executes `auxiliary_llm` through its own
trusted model seam, then returns a fenced `ResolveHostCallbackRequest`.
`maintenance.poll` recovers persisted jobs after host restarts or callback
timeouts. Provider selection and credentials remain host-owned.

## Context policy

`@cortexkit/magic-context-core-plugin/context-policy` owns the deterministic
policy shared by every host:

- input-side token pressure (`input + cache read + cache write`, excluding
  output), including separate soft-window and provider-wall percentages;
- percentage and absolute-token execute-threshold resolution, progressive
  model matching, force/emergency pressure bands, and pressure floors;
- context budget partitioning, history budget, historian trigger budget, and
  historian chunk budget;
- cache TTL parsing and the composed execute/defer/force/emergency scheduler,
  including mid-tool deferral and the emergency drain latch.

Hosts remain responsible for observing native usage, resolving trusted context
windows, supplying equivalent model-key spellings, logging diagnostics, and
persisting the returned state. This package is intentionally isolated from the
existing OpenCode and Pi packages; future host adapters consume its public
Interface without editing or importing those implementations.

This is still an incremental extraction. The independent runtime now provides
a conservative host-neutral protected-tail and bounded-reduction path, durable
memory and recall, context tools, lifecycle state, cache/tool feedback,
automatic triggers, and the Historian/Dreamer/Sidekick execution chain.
Workspace visibility and the remaining production promotion/detail policies
still remain in their current packages until they move behind this Interface.
