"""Hermes registration entry point for Magic Context."""

from __future__ import annotations

from .engine import MagicContextEngine
from .runtime_bridge import RuntimeBridge, RuntimeBridgeError


def register(ctx) -> None:
    """Register plugin-owned model slots and the context engine prototype."""
    ctx.register_auxiliary_task(
        key="magic_context_historian",
        display_name="Magic Context Historian",
        description="Consolidates completed Hermes turns into durable context compartments.",
        defaults={"temperature": 0.1},
    )
    ctx.register_auxiliary_task(
        key="magic_context_dreamer",
        display_name="Magic Context Dreamer",
        description="Maintains and promotes long-lived project memories.",
        defaults={"temperature": 0.2},
    )
    ctx.register_auxiliary_task(
        key="magic_context_sidekick",
        display_name="Magic Context Sidekick",
        description="Performs bounded background context-maintenance tasks.",
        defaults={"temperature": 0.1},
    )
    engine = MagicContextEngine(runtime=RuntimeBridge.from_environment(), llm=ctx.llm)
    ctx.register_context_engine(engine)

    if hasattr(ctx, "register_hook"):
        ctx.register_hook(
            "pre_tool_call",
            lambda **event: engine.observe_tool_event("pre", **event),
        )
        ctx.register_hook(
            "post_tool_call",
            lambda **event: engine.observe_tool_event("post", **event),
        )

        def on_session_reset(
            session_id: str = "", reason: str = "host_reset", **_: object
        ) -> None:
            if session_id:
                engine.observe_session_reset(session_id, reason=reason)

        def on_session_finalize(
            session_id: str = "", reason: str = "", **_: object
        ) -> None:
            if session_id and any(word in reason.lower() for word in ("delete", "prune")):
                engine.on_session_delete(session_id, reason=reason)

        ctx.register_hook("on_session_reset", on_session_reset)
        ctx.register_hook("on_session_finalize", on_session_finalize)


__all__ = ["MagicContextEngine", "RuntimeBridge", "RuntimeBridgeError", "register"]
