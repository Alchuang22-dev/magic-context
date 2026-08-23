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
    ctx.register_context_engine(
        MagicContextEngine(runtime=RuntimeBridge.from_environment(), llm=ctx.llm)
    )


__all__ = ["MagicContextEngine", "RuntimeBridge", "RuntimeBridgeError", "register"]
