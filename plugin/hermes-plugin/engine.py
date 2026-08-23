"""Magic Context `ContextEngine` implementation for Hermes."""

from __future__ import annotations

from collections import deque
import copy
import json
import logging
import threading
import time
import uuid
from typing import Any

from agent.context_engine import ContextEngine

from .hermes_adapter import (
    compose_request,
    estimate_tokens,
    materialize_plan,
    observe_request,
    safe_fallback,
)
from .runtime_bridge import RuntimeBridge, RuntimeBridgeError

logger = logging.getLogger(__name__)


class MagicContextEngine(ContextEngine):
    emit_automatic_compaction_status = False
    protect_first_n = 0
    protect_last_n = 0

    def __init__(
        self,
        *,
        runtime: RuntimeBridge | Any | None = None,
        llm: Any = None,
        context_length: int = 0,
    ) -> None:
        self.runtime = runtime or RuntimeBridge()
        self.llm = llm
        self.context_length = max(0, int(context_length or 0))
        self.threshold_tokens = int(self.context_length * 0.82) if self.context_length else 0
        self.last_prompt_tokens = 0
        self.last_completion_tokens = 0
        self.last_total_tokens = 0
        self.compression_count = 0
        self.session_id = "unbound"
        self.model_key: str | None = None
        self.project_id: str | None = None
        self._last_usage: dict[str, Any] | None = None
        self._runtime_failures = 0
        self._fallback_count = 0
        self._lock = threading.RLock()
        self._observe_queue: deque[dict[str, Any]] = deque()
        self._observe_worker_active = False

    @property
    def name(self) -> str:
        return "magic-context"

    def __deepcopy__(self, memo: dict[int, Any]) -> "MagicContextEngine":
        copied = type(self)(
            runtime=self.runtime,
            llm=self.llm,
            context_length=self.context_length,
        )
        copied.threshold_tokens = self.threshold_tokens
        copied.project_id = self.project_id
        memo[id(self)] = copied
        return copied

    def on_session_start(self, session_id: str, **kwargs: Any) -> None:
        with self._lock:
            self.session_id = session_id or "unbound"
            context_length = kwargs.get("context_length")
            if isinstance(context_length, int) and context_length > 0:
                self.context_length = context_length
                self.threshold_tokens = int(context_length * 0.82)
            model = kwargs.get("model")
            self.model_key = str(model) if model else None
            project = next(
                (
                    kwargs.get(key)
                    for key in ("project_id", "project_path", "cwd", "working_directory")
                    if kwargs.get(key)
                ),
                None,
            )
            self.project_id = str(project) if project else None

    def on_session_reset(self) -> None:
        with self._lock:
            self.last_prompt_tokens = 0
            self.last_completion_tokens = 0
            self.last_total_tokens = 0
            self._last_usage = None
            self._runtime_failures = 0
            self._fallback_count = 0

    def update_from_response(self, usage: dict[str, Any]) -> None:
        with self._lock:
            self.last_prompt_tokens = int(
                usage.get("input_tokens", usage.get("prompt_tokens", 0)) or 0
            )
            self.last_completion_tokens = int(
                usage.get("output_tokens", usage.get("completion_tokens", 0)) or 0
            )
            self.last_total_tokens = int(
                usage.get(
                    "total_tokens",
                    self.last_prompt_tokens + self.last_completion_tokens,
                )
                or 0
            )
            self._last_usage = copy.deepcopy(usage)

    def should_compress(self, prompt_tokens: int = None) -> bool:
        # Per-request selection owns the provider window. Host compaction must
        # remain dormant to avoid persisting a second, incompatible summary.
        return False

    def should_compress_preflight(self, messages: list[dict[str, Any]]) -> bool:
        return False

    def compress(
        self,
        messages: list[dict[str, Any]],
        current_tokens: int | None = None,
        focus_topic: str | None = None,
        force: bool = False,
        memory_context: str = "",
    ) -> list[dict[str, Any]]:
        del current_tokens, focus_topic, force, memory_context
        with self._lock:
            self.compression_count += 1
            self._fallback_count += 1
        return safe_fallback(messages, self.context_length)

    def select_context(
        self,
        request_messages: list[dict[str, Any]],
        *,
        conversation_messages: list[dict[str, Any]] = None,
        incoming_message: dict[str, Any] = None,
        budget_tokens: int = 0,
    ) -> list[dict[str, Any]]:
        del conversation_messages, incoming_message
        budget = int(budget_tokens or self.context_length or 0)
        request_id = uuid.uuid4().hex
        request, index_by_id = compose_request(
            request_messages,
            request_id=request_id,
            session_id=self.session_id,
            budget_tokens=budget,
            model_key=self.model_key,
            project_id=self.project_id,
            usage=self._last_usage,
        )
        try:
            plan = self.runtime.call("context.compose", request)
            if plan is not None:
                selected = materialize_plan(request_messages, request, index_by_id, plan)
                if budget > 0 and estimate_tokens(selected) > int(budget * 0.9):
                    with self._lock:
                        self._fallback_count += 1
                    return safe_fallback(selected, budget)
                return selected
        except (RuntimeBridgeError, ValueError, TypeError, KeyError) as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context runtime selection failed; using bounded fallback: %s", exc)

        selected = safe_fallback(request_messages, budget)
        if selected != request_messages:
            with self._lock:
                self._fallback_count += 1
        return selected

    def on_turn_complete(
        self,
        messages: list[dict[str, Any]],
        usage: dict[str, Any] = None,
        **kwargs: Any,
    ) -> None:
        if not getattr(self.runtime, "available", False):
            return
        turn_id = kwargs.get("turn_id")
        payload = observe_request(
            messages,
            observation_id=str(turn_id or uuid.uuid4().hex),
            session_id=self.session_id,
            observed_at_ms=int(time.time() * 1000),
            usage=copy.deepcopy(usage),
            context_limit_tokens=self.context_length,
            model_key=self.model_key,
            project_id=self.project_id,
            turn_id=str(turn_id) if turn_id else None,
            task_id=str(kwargs["task_id"]) if kwargs.get("task_id") else None,
            interrupted=bool(kwargs.get("interrupted", False)),
            failed=bool(kwargs.get("failed", False)),
            exit_reason=kwargs.get("turn_exit_reason"),
            memory_candidates=(
                copy.deepcopy(kwargs["memory_candidates"])
                if isinstance(kwargs.get("memory_candidates"), list)
                else None
            ),
        )
        with self._lock:
            self._observe_queue.append(payload)
            if self._observe_worker_active:
                return
            self._observe_worker_active = True
            threading.Thread(
                target=self._drain_observations,
                name=f"magic-context-observe-{self.session_id[:12]}",
                daemon=True,
            ).start()

    def _drain_observations(self) -> None:
        while True:
            with self._lock:
                if not self._observe_queue:
                    self._observe_worker_active = False
                    return
                payload = self._observe_queue.popleft()
            self._observe_turn(payload)

    def _observe_turn(self, payload: dict[str, Any]) -> None:
        try:
            self.runtime.call("turn.observe", payload)
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context turn observation failed: %s", exc)

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "ctx_status",
                "description": "Inspect the active Magic Context runtime and context budget state.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            }
        ]

    def handle_tool_call(self, name: str, args: dict[str, Any], **kwargs: Any) -> str:
        del args, kwargs
        if name != "ctx_status":
            return json.dumps({"error": f"Unknown Magic Context tool: {name}"})
        return json.dumps(self.get_status(), ensure_ascii=False)

    def get_status(self) -> dict[str, Any]:
        return {
            "engine": self.name,
            "session_id": self.session_id,
            "project_id": self.project_id,
            "runtime_available": bool(getattr(self.runtime, "available", False)),
            "context_length": self.context_length,
            "threshold_tokens": self.threshold_tokens,
            "last_prompt_tokens": self.last_prompt_tokens,
            "last_completion_tokens": self.last_completion_tokens,
            "last_total_tokens": self.last_total_tokens,
            "estimated_last_prompt_tokens": self.last_prompt_tokens,
            "runtime_failures": self._runtime_failures,
            "safe_fallback_count": self._fallback_count,
        }
