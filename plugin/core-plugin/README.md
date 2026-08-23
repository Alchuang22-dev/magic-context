# Magic Context Core Plugin

This package is the host-neutral core for Magic Context integrations. It
contains no OpenCode, Pi, Hermes, provider SDK, transport, or storage imports.

The protocol deliberately separates two concerns:

- the runtime decides what context to retain, reduce, recall, and inject;
- the host adapter decides how that plan is represented on its provider wire.

New agent integrations should implement `AgentContextAdapter` and exchange a
`ComposeContextRequest` / `ContextPlan` with the Magic Context runtime. They
must not import implementation files from another host plugin.

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

This is still an incremental extraction. Protected-tail selection, reduction,
m[0]/m[1] composition, memory recall, and historian execution remain in their
current packages until those subsystems move behind the protocol.
