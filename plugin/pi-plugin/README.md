# Thin Pi Adapter

`PiContextAdapter` translates Pi `AgentMessage` objects and optional stable
SessionEntry ids to the canonical transcript and materializes a `ContextPlan`.
It contains no context policy or persistence logic. The shared
`RuntimeAgentController` supplies the execution chain.

The codec is ready for entrypoint cutover. The published Pi hook registration
remains in `packages/pi-plugin` until its host fixture suite is replayed through
this Adapter.
