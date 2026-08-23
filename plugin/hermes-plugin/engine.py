"""Magic Context `ContextEngine` implementation for Hermes."""

from __future__ import annotations

from collections import deque
import copy
import json
import logging
import os
import re
import threading
import time
import uuid
from typing import Any

from agent.context_engine import ContextEngine

from .hermes_adapter import (
    cache_feedback_request,
    callback_resolution_request,
    compose_request,
    estimate_tokens,
    lifecycle_request,
    maintenance_poll_request,
    materialize_plan,
    observe_request,
    safe_fallback,
    tool_event_request,
    tool_execute_request,
)
from .runtime_bridge import RuntimeBridge, RuntimeBridgeError

logger = logging.getLogger(__name__)

_AUXILIARY_TASK_KEYS = {
    "historian": "magic_context_historian",
    "dreamer": "magic_context_dreamer",
    "sidekick": "magic_context_sidekick",
}
_MAX_CALLBACK_CHAIN = 8
_MAINTENANCE_POLL_SECONDS = 30.0
_SECRET_PATTERN = re.compile(r"(?:sk|key|token)-[A-Za-z0-9_-]{12,}", re.IGNORECASE)


def _result_value(result: Any, name: str, default: Any = None) -> Any:
    if isinstance(result, dict):
        return result.get(name, default)
    return getattr(result, name, default)


def _callback_usage(result: Any) -> dict[str, int | float] | None:
    usage = _result_value(result, "usage")
    if usage is None:
        return None
    aliases = {
        "inputTokens": "input_tokens",
        "outputTokens": "output_tokens",
        "cacheReadTokens": "cache_read_tokens",
        "cacheWriteTokens": "cache_write_tokens",
    }
    normalized: dict[str, int | float] = {}
    for target, source in aliases.items():
        value = _result_value(usage, source, 0)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            normalized[target] = value
    return normalized or None


def _safe_error_message(exc: BaseException) -> str:
    return _SECRET_PATTERN.sub("[redacted]", str(exc))[:1000]


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
        auxiliary_policy: dict[str, Any] | None = None,
    ) -> None:
        self.runtime = runtime or RuntimeBridge()
        self.llm = llm
        self.context_length = max(0, int(context_length or 0))
        self.auxiliary_policy = copy.deepcopy(auxiliary_policy or {})
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
        self._cache_read_tokens = 0
        self._cache_write_tokens = 0
        self._callbacks_completed = 0
        self._callback_timeouts = 0
        self._callback_failures = 0
        self._lock = threading.RLock()
        self._observe_queue: deque[dict[str, Any]] = deque()
        self._observe_worker_active = False
        self._maintenance_stop = threading.Event()

    @property
    def name(self) -> str:
        return "magic-context"

    def __deepcopy__(self, memo: dict[int, Any]) -> "MagicContextEngine":
        copied = type(self)(
            runtime=self.runtime,
            llm=self.llm,
            context_length=self.context_length,
            auxiliary_policy=self.auxiliary_policy,
        )
        copied.threshold_tokens = self.threshold_tokens
        copied.project_id = self.project_id
        memo[id(self)] = copied
        return copied

    def on_session_start(self, session_id: str, **kwargs: Any) -> None:
        with self._lock:
            self._maintenance_stop.set()
            self._maintenance_stop = threading.Event()
            maintenance_stop = self._maintenance_stop
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
            self.project_id = str(project) if project else os.getcwd()
        self._send_lifecycle("start", self.session_id)
        if getattr(self.runtime, "available", False):
            threading.Thread(
                target=self._maintenance_loop,
                args=(self.session_id, maintenance_stop),
                name=f"magic-context-maintenance-{self.session_id[:12]}",
                daemon=True,
            ).start()

    def on_session_end(
        self, session_id: str, messages: list[dict[str, Any]]
    ) -> None:
        self._send_lifecycle("end", session_id or self.session_id, messages=messages)
        self._maintenance_stop.set()

    def on_session_reset(self) -> None:
        with self._lock:
            self.last_prompt_tokens = 0
            self.last_completion_tokens = 0
            self.last_total_tokens = 0
            self._last_usage = None
            self._runtime_failures = 0
            self._fallback_count = 0
            self._cache_read_tokens = 0
            self._cache_write_tokens = 0
            self._callbacks_completed = 0
            self._callback_timeouts = 0
            self._callback_failures = 0

    def carry_over_new_session_context(
        self, old_session_id: str, new_session_id: str
    ) -> None:
        self._send_lifecycle(
            "clone",
            old_session_id,
            target_session_id=new_session_id,
            reason="host_carry_over",
        )

    def on_session_delete(self, session_id: str, *, reason: str = "host_delete") -> None:
        self._send_lifecycle("delete", session_id, reason=reason)

    def observe_session_reset(self, session_id: str, *, reason: str = "host_reset") -> None:
        self._send_lifecycle("reset", session_id, reason=reason)

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
            self._cache_read_tokens += int(usage.get("cache_read_tokens", 0) or 0)
            self._cache_write_tokens += int(usage.get("cache_write_tokens", 0) or 0)
            session_id = self.session_id
            model_key = self.model_key
            project_id = self.project_id
            context_length = self.context_length
        if session_id == "unbound" or not getattr(self.runtime, "available", False):
            return
        payload = cache_feedback_request(
            event_id=uuid.uuid4().hex,
            session_id=session_id,
            observed_at_ms=int(time.time() * 1000),
            usage=copy.deepcopy(usage),
            context_limit_tokens=context_length,
            model_key=model_key,
            project_id=project_id,
        )
        try:
            self.runtime.call("cache.observe", payload)
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context cache observation failed: %s", exc)

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
        try:
            for _ in range(3):
                request, index_by_id = compose_request(
                    request_messages,
                    request_id=uuid.uuid4().hex,
                    session_id=self.session_id,
                    budget_tokens=budget,
                    model_key=self.model_key,
                    project_id=self.project_id,
                    usage=self._last_usage,
                )
                plan = self.runtime.call("context.compose", request)
                if plan is None:
                    break
                callbacks = plan.get("callbacks") if isinstance(plan, dict) else None
                if callbacks:
                    self._dispatch_runtime_callbacks(plan)
                    continue
                selected = materialize_plan(request_messages, request, index_by_id, plan)
                if budget > 0 and estimate_tokens(selected) > int(budget * 0.9):
                    with self._lock:
                        self._fallback_count += 1
                    return safe_fallback(selected, budget)
                return selected
            raise RuntimeBridgeError("context.compose callback chain did not converge")
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
            response = self.runtime.call("turn.observe", payload)
            if isinstance(response, dict) and response.get("callbacks"):
                self._dispatch_runtime_callbacks(response)
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context turn observation failed: %s", exc)

    def _validated_callback(
        self, callback: Any, *, expected_session_id: str | None = None
    ) -> dict[str, Any]:
        if not isinstance(callback, dict):
            raise RuntimeBridgeError("runtime callback must be an object")
        if callback.get("protocolVersion") != 1 or callback.get("kind") != "auxiliary_llm":
            raise RuntimeBridgeError("runtime returned an unsupported callback")
        session_id = callback.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeBridgeError("runtime callback has no sessionId")
        if expected_session_id and session_id != expected_session_id:
            raise RuntimeBridgeError("runtime callback crossed session identity")
        task = callback.get("task")
        if task not in _AUXILIARY_TASK_KEYS:
            raise RuntimeBridgeError(f"runtime callback task is unsupported: {task}")
        if callback.get("taskKey") != _AUXILIARY_TASK_KEYS[task]:
            raise RuntimeBridgeError("runtime callback taskKey does not match its task")
        for field in ("callbackId", "purpose"):
            if not isinstance(callback.get(field), str) or not callback[field]:
                raise RuntimeBridgeError(f"runtime callback has no {field}")
        if not isinstance(callback.get("attempt"), int) or callback["attempt"] < 1:
            raise RuntimeBridgeError("runtime callback attempt must be positive")
        if not isinstance(callback.get("deadlineAtMs"), (int, float)):
            raise RuntimeBridgeError("runtime callback has no deadline")
        request = callback.get("request")
        if not isinstance(request, dict) or request.get("mode") not in {
            "complete",
            "structured",
        }:
            raise RuntimeBridgeError("runtime callback LLM request is invalid")
        return callback

    def _execute_runtime_callback(self, callback: dict[str, Any]) -> dict[str, Any]:
        now_ms = int(time.time() * 1000)
        deadline_ms = int(callback["deadlineAtMs"])
        if deadline_ms <= now_ms:
            with self._lock:
                self._callback_timeouts += 1
            return {
                "status": "timed_out",
                "errorType": "CallbackDeadlineExceeded",
                "message": "callback deadline elapsed before Hermes execution",
            }
        if self.llm is None:
            with self._lock:
                self._callback_failures += 1
            return {
                "status": "failed",
                "errorType": "AuxiliaryLlmUnavailable",
                "message": "Hermes ctx.llm is unavailable",
            }

        request = callback["request"]
        timeout_seconds = max(0.001, (deadline_ms - now_ms) / 1000)
        common = {
            "temperature": request.get("temperature"),
            "max_tokens": request.get("maxTokens"),
            "timeout": timeout_seconds,
            "purpose": callback["purpose"],
            "task": callback["taskKey"],
        }
        try:
            if request["mode"] == "structured":
                result = self.llm.complete_structured(
                    instructions=request.get("instructions", ""),
                    input=request.get("input", []),
                    json_schema=request.get("jsonSchema"),
                    json_mode=True,
                    schema_name=request.get("schemaName"),
                    system_prompt=request.get("systemPrompt"),
                    **common,
                )
            else:
                result = self.llm.complete(
                    messages=request.get("messages", []),
                    **common,
                )
            text = _result_value(result, "text")
            if not isinstance(text, str):
                raise TypeError("Hermes ctx.llm result has no text")
            outcome: dict[str, Any] = {
                "status": "completed",
                "text": text,
            }
            parsed = _result_value(result, "parsed")
            if parsed is not None:
                outcome["parsed"] = copy.deepcopy(parsed)
            for field in ("provider", "model"):
                value = _result_value(result, field)
                if value:
                    outcome[field] = str(value)
            usage = _callback_usage(result)
            if usage:
                outcome["usage"] = usage
            with self._lock:
                self._callbacks_completed += 1
            return outcome
        except Exception as exc:
            timed_out = isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower()
            with self._lock:
                if timed_out:
                    self._callback_timeouts += 1
                else:
                    self._callback_failures += 1
            return {
                "status": "timed_out" if timed_out else "failed",
                "errorType": type(exc).__name__,
                "message": _safe_error_message(exc),
            }

    def _dispatch_runtime_callbacks(self, response: dict[str, Any]) -> int:
        raw_callbacks = response.get("callbacks", [])
        if not isinstance(raw_callbacks, list):
            raise RuntimeBridgeError("runtime callbacks must be an array")
        expected_session_id = response.get("sessionId")
        queue = deque(raw_callbacks)
        seen: set[tuple[str, int]] = set()
        completed = 0
        while queue and completed < _MAX_CALLBACK_CHAIN:
            callback = self._validated_callback(
                queue.popleft(),
                expected_session_id=(
                    expected_session_id if isinstance(expected_session_id, str) else None
                ),
            )
            fence = (callback["callbackId"], callback["attempt"])
            if fence in seen:
                continue
            seen.add(fence)
            outcome = self._execute_runtime_callback(callback)
            receipt = self.runtime.call(
                "host.callback.resolve",
                callback_resolution_request(
                    callback,
                    outcome,
                    resolution_id=uuid.uuid4().hex,
                    resolved_at_ms=int(time.time() * 1000),
                ),
            )
            if not isinstance(receipt, dict):
                raise RuntimeBridgeError("host.callback.resolve returned an invalid receipt")
            followups = receipt.get("callbacks", [])
            if not isinstance(followups, list):
                raise RuntimeBridgeError("callback resolution followups must be an array")
            queue.extend(followups)
            completed += 1
        if queue:
            raise RuntimeBridgeError("runtime callback chain exceeded its bounded limit")
        return completed

    def _poll_maintenance(self, session_id: str) -> None:
        try:
            response = self.runtime.call(
                "maintenance.poll",
                maintenance_poll_request(
                    poll_id=uuid.uuid4().hex,
                    session_id=session_id,
                    polled_at_ms=int(time.time() * 1000),
                    tasks=["historian", "dreamer"],
                ),
            )
            if isinstance(response, dict) and response.get("callbacks"):
                self._dispatch_runtime_callbacks(response)
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context maintenance poll failed: %s", exc)

    def _maintenance_loop(
        self, session_id: str, stop: threading.Event
    ) -> None:
        while not stop.is_set():
            self._poll_maintenance(session_id)
            stop.wait(_MAINTENANCE_POLL_SECONDS)

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "ctx_status",
                "description": "Inspect the active Magic Context runtime and context budget state.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
            {
                "name": "ctx_search",
                "description": "Search durable memories, notes, and stored raw session messages. Message hits include ordinals that can be expanded.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "number"},
                        "sources": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": ["memory", "message", "git_commit", "primer", "note"],
                            },
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "ctx_memory",
                "description": "Write, update, archive, merge, get, or list durable project memories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["write", "update", "archive", "merge", "get", "list"],
                        },
                        "content": {"type": "string"},
                        "category": {
                            "type": "string",
                            "enum": [
                                "PROJECT_RULES",
                                "ARCHITECTURE",
                                "CONSTRAINTS",
                                "CONFIG_VALUES",
                                "NAMING",
                            ],
                        },
                        "ids": {"type": "array", "items": {"type": "number"}},
                        "limit": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": ["action"],
                },
            },
            {
                "name": "ctx_expand",
                "description": "Recover a full stored message by ordinal, or render a stored ordinal range. Reduced content remains recoverable.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "start": {"type": "number"},
                        "end": {"type": "number"},
                        "verbose": {"type": "boolean"},
                        "message": {"type": "number"},
                    },
                    "required": [],
                },
            },
            {
                "name": "ctx_reduce",
                "description": "Persistently remove stale message ordinals from future provider context while preserving raw history for ctx_expand. Ranges such as '3-5,8' are accepted.",
                "parameters": {
                    "type": "object",
                    "properties": {"drop": {"type": "string"}},
                    "required": ["drop"],
                },
            },
            {
                "name": "ctx_note",
                "description": "Write, read, update, or dismiss session notes. A surface_condition of tool:<name> auto-triggers after that tool succeeds.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["write", "read", "dismiss", "update"],
                        },
                        "content": {"type": "string"},
                        "surface_condition": {"type": "string"},
                        "filter": {
                            "type": "string",
                            "enum": ["all", "active", "pending", "ready", "dismissed"],
                        },
                        "limit": {"type": "number"},
                        "offset": {"type": "number"},
                        "note_id": {"type": "number"},
                    },
                    "required": [],
                },
            },
        ]

    def handle_tool_call(self, name: str, args: dict[str, Any], **kwargs: Any) -> str:
        if name == "ctx_status":
            return json.dumps(self.get_status(), ensure_ascii=False)
        if name not in {"ctx_search", "ctx_memory", "ctx_expand", "ctx_reduce", "ctx_note"}:
            return json.dumps({"error": f"Unknown Magic Context tool: {name}"})
        if not getattr(self.runtime, "available", False):
            return "Error: Magic Context runtime is not configured."
        messages = kwargs.get("messages")
        payload = tool_execute_request(
            messages if isinstance(messages, list) else [],
            request_id=str(
                kwargs.get("tool_call_id")
                or kwargs.get("call_id")
                or uuid.uuid4().hex
            ),
            session_id=self.session_id,
            tool_name=name,
            arguments=args if isinstance(args, dict) else {},
            invoked_at_ms=int(time.time() * 1000),
            model_key=self.model_key,
            project_id=self.project_id,
        )
        try:
            result = self.runtime.call("tool.execute", payload)
            if not isinstance(result, dict) or not isinstance(result.get("output"), str):
                raise RuntimeBridgeError("tool.execute returned an invalid result")
            return result["output"]
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context tool %s failed: %s", name, exc)
            return f"Error: Magic Context runtime failed while executing {name}."

    def observe_tool_event(self, phase: str, **event: Any) -> None:
        session_id = str(event.get("session_id") or self.session_id or "unbound")
        if session_id == "unbound" or not getattr(self.runtime, "available", False):
            return
        tool_name = str(event.get("tool_name") or "unknown")
        tool_call_id = str(event.get("tool_call_id") or "")
        turn_id = str(event.get("turn_id") or "")
        event_seed = ":".join(
            value for value in (session_id, turn_id, tool_call_id, tool_name, phase) if value
        )
        payload = tool_event_request(
            event_id=event_seed if (tool_call_id or turn_id) else uuid.uuid4().hex,
            session_id=session_id,
            observed_at_ms=int(time.time() * 1000),
            phase=phase,
            tool_name=tool_name,
            arguments=event.get("args") if isinstance(event.get("args"), dict) else None,
            result=event.get("result") if phase == "post" else None,
            status=str(event["status"]) if event.get("status") else None,
            duration_ms=event.get("duration_ms"),
            tool_call_id=tool_call_id or None,
            turn_id=turn_id or None,
            task_id=str(event.get("task_id") or "") or None,
        )
        try:
            self.runtime.call("tool.observe", payload)
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context tool event observation failed: %s", exc)

    def _send_lifecycle(
        self,
        action: str,
        session_id: str,
        *,
        messages: list[dict[str, Any]] | None = None,
        target_session_id: str | None = None,
        reason: str | None = None,
    ) -> None:
        if not session_id or session_id == "unbound" or not getattr(
            self.runtime, "available", False
        ):
            return
        payload = lifecycle_request(
            event_id=uuid.uuid4().hex,
            session_id=session_id,
            action=action,
            observed_at_ms=int(time.time() * 1000),
            messages=messages,
            target_session_id=target_session_id,
            model_key=self.model_key,
            project_id=self.project_id,
            reason=reason,
            auxiliary_policy=(
                self.auxiliary_policy
                if action == "start" and self.auxiliary_policy
                else None
            ),
        )
        try:
            self.runtime.call("session.lifecycle", payload)
        except Exception as exc:
            with self._lock:
                self._runtime_failures += 1
            logger.warning("magic-context session lifecycle %s failed: %s", action, exc)

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
            "cache_read_tokens": self._cache_read_tokens,
            "cache_write_tokens": self._cache_write_tokens,
            "auxiliary_callbacks_completed": self._callbacks_completed,
            "auxiliary_callback_timeouts": self._callback_timeouts,
            "auxiliary_callback_failures": self._callback_failures,
        }
