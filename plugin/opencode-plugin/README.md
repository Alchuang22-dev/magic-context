# Thin OpenCode Adapter

`OpenCodeContextAdapter` translates OpenCode `Message + Part` objects to the
canonical transcript and materializes a `ContextPlan`. It contains no context
policy or persistence logic. The shared `RuntimeAgentController` supplies the
execution chain.

The codec is ready for entrypoint cutover. The published OpenCode hook
registration remains in `packages/plugin` until its host fixture suite is
replayed through this Adapter.
