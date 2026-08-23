"""Hermes registration entry point for Magic Context."""

from __future__ import annotations

from .engine import MagicContextEngine
from .runtime_bridge import RuntimeBridge, RuntimeBridgeError


def _setting(ctx, key: str, default):
    getter = getattr(ctx, "get_config", None)
    if not callable(getter):
        return default
    value = getter(key, default)
    if isinstance(default, bool):
        return value if isinstance(value, bool) else default
    if isinstance(default, int):
        return value if isinstance(value, int) and not isinstance(value, bool) else default
    if isinstance(default, float):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default
    return value


def _auxiliary_policy(ctx) -> dict:
    return {
        "historianEnabled": _setting(ctx, "historian_enabled", True),
        "historianThresholdPercentage": _setting(
            ctx, "historian_threshold_percentage", 65.0
        ),
        "historianMinMessages": _setting(ctx, "historian_min_messages", 8),
        "historianProtectedTailMessages": _setting(
            ctx, "historian_protected_tail_messages", 3
        ),
        "historianTimeoutMs": _setting(ctx, "historian_timeout_ms", 600_000),
        "dreamerEnabled": _setting(ctx, "dreamer_enabled", True),
        "dreamerIntervalMs": _setting(ctx, "dreamer_interval_ms", 86_400_000),
        "dreamerTimeoutMs": _setting(ctx, "dreamer_timeout_ms", 600_000),
        "sidekickEnabled": _setting(ctx, "sidekick_enabled", False),
        "sidekickTimeoutMs": _setting(ctx, "sidekick_timeout_ms", 120_000),
        "maxAttempts": _setting(ctx, "auxiliary_max_attempts", 3),
    }


def register(ctx) -> None:
    """Register plugin-owned model slots and the context engine prototype."""
    auxiliary_policy = _auxiliary_policy(ctx)
    ctx.register_auxiliary_task(
        key="magic_context_historian",
        display_name="Magic Context Historian",
        description="Consolidates completed Hermes turns into durable context compartments.",
        defaults={"temperature": 0.1, "timeout": 600},
    )
    ctx.register_auxiliary_task(
        key="magic_context_dreamer",
        display_name="Magic Context Dreamer",
        description="Maintains and promotes long-lived project memories.",
        defaults={"temperature": 0.2, "timeout": 600},
    )
    ctx.register_auxiliary_task(
        key="magic_context_sidekick",
        display_name="Magic Context Sidekick",
        description="Retrieves focused context for the active Hermes request.",
        defaults={"temperature": 0.1, "timeout": 120},
    )
    engine = MagicContextEngine(
        runtime=RuntimeBridge.from_environment(),
        llm=ctx.llm,
        auxiliary_policy=auxiliary_policy,
    )
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
