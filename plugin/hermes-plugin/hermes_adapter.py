"""Hermes message codec and ContextPlan materializer."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from typing import Any, Iterable

PROTOCOL_VERSION = 1
_INJECTION_ORDER = {"stable_prefix": 0, "volatile_delta": 1, "tail_nudge": 2}
_TRUNCATION_MARKER = "\n...[bounded by Magic Context safe fallback]...\n"
_TAG_PREFIX = re.compile(r"^(?:§\d+§\s*)+")


class InvalidContextPlanError(ValueError):
    """A runtime plan cannot be applied to the supplied request snapshot."""


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def estimate_tokens(messages: Iterable[dict[str, Any]]) -> int:
    """Conservative dependency-free estimate for adapter safety decisions."""
    byte_count = len(_stable_json(list(messages)).encode("utf-8"))
    return max(1, (byte_count + 2) // 3)


def _message_id(message: dict[str, Any], ordinal: int) -> str:
    for key in ("_row_id", "id", "message_id"):
        value = message.get(key)
        if isinstance(value, (str, int)) and str(value):
            return f"hermes:{key}:{value}"
    digest = hashlib.sha256(
        f"{ordinal}:".encode("utf-8") + _stable_json(message).encode("utf-8")
    ).hexdigest()[:24]
    return f"hermes:derived:{digest}"


def _canonical_content(
    message: dict[str, Any], message_id: str
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    content = message.get("content", "")
    if message.get("role") != "tool":
        if isinstance(content, str):
            blocks.append({"kind": "text", "text": content})
        elif isinstance(content, list):
            for index, raw in enumerate(content):
                if not isinstance(raw, dict):
                    blocks.append({"kind": "opaque", "value": raw})
                    continue
                kind = raw.get("type")
                if kind in {"text", "input_text", "output_text"}:
                    blocks.append(
                        {
                            "id": str(raw.get("id")) if raw.get("id") is not None else None,
                            "kind": "text",
                            "text": str(raw.get("text", "")),
                        }
                    )
                elif kind in {"thinking", "reasoning"}:
                    blocks.append(
                        {
                            "id": str(raw.get("id")) if raw.get("id") is not None else None,
                            "kind": "thinking",
                            "text": str(raw.get("text", raw.get("thinking", ""))),
                        }
                    )
                else:
                    blocks.append(
                        {
                            "id": str(raw.get("id", index)),
                            "kind": "opaque",
                            "value": copy.deepcopy(raw),
                        }
                    )
        else:
            blocks.append({"kind": "opaque", "value": copy.deepcopy(content)})

    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list):
        for raw in tool_calls:
            if not isinstance(raw, dict):
                continue
            function = raw.get("function") if isinstance(raw.get("function"), dict) else {}
            arguments = function.get("arguments", {})
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    pass
            blocks.append(
                {
                    "kind": "tool_call",
                    "callId": str(raw.get("id", "")),
                    "name": str(function.get("name", raw.get("name", "unknown"))),
                    "input": arguments,
                }
            )
    if message.get("role") == "tool":
        blocks.append(
            {
                "kind": "tool_result",
                "callId": str(message.get("tool_call_id", "")),
                "name": str(message.get("name", "")) or None,
                "output": copy.deepcopy(content),
            }
        )
    for index, block in enumerate(blocks):
        native_id = block.get("id") or block.get("callId") or index
        block["id"] = f"{message_id}:block:{block.get('kind', 'opaque')}:{native_id}:{index}"
    return blocks


def snapshot_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    canonical: list[dict[str, Any]] = []
    index_by_id: dict[str, int] = {}
    for index, message in enumerate(messages):
        message_id = _message_id(message, index + 1)
        if message_id in index_by_id:
            message_id = f"{message_id}:ordinal:{index + 1}"
        index_by_id[message_id] = index
        canonical.append(
            {
                "id": message_id,
                "ordinal": index + 1,
                "role": str(message.get("role", "user")),
                "content": _canonical_content(message, message_id),
            }
        )
    return canonical, index_by_id


def canonical_usage(
    usage: dict[str, Any] | None,
    context_limit_tokens: int = 0,
) -> dict[str, int | float]:
    if not isinstance(usage, dict):
        usage = {}
    aliases = {
        "inputTokens": ("input_tokens", "prompt_tokens"),
        "outputTokens": ("output_tokens", "completion_tokens"),
        "cacheReadTokens": ("cache_read_tokens",),
        "cacheWriteTokens": ("cache_write_tokens",),
        "reasoningTokens": ("reasoning_tokens",),
    }
    normalized: dict[str, int | float] = {}
    for target, sources in aliases.items():
        value = next(
            (usage.get(source) for source in sources if usage.get(source) is not None),
            None,
        )
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            and value >= 0
        ):
            normalized[target] = value
    if context_limit_tokens > 0:
        normalized["contextLimitTokens"] = int(context_limit_tokens)
    return normalized


def compose_request(
    messages: list[dict[str, Any]],
    *,
    request_id: str,
    session_id: str,
    budget_tokens: int,
    model_key: str | None = None,
    project_id: str | None = None,
    usage: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, int]]:
    canonical, index_by_id = snapshot_messages(messages)
    request = {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "host": "hermes",
        "sessionId": session_id,
        "budgetTokens": max(0, int(budget_tokens or 0)),
        "capabilities": {
            "preRequestTransform": True,
            "stableMessageIds": any("_row_id" in message for message in messages),
            "stablePartIds": True,
            "usageObservation": True,
            "auxiliaryLlm": True,
            "toolRegistration": True,
            "toolEvents": True,
            "requestBlocking": False,
            "systemSuffixInjection": True,
            "promptCacheFacts": False,
            "blockIndexMutations": True,
        },
        "messages": canonical,
    }
    if model_key:
        request["modelKey"] = str(model_key)
    if project_id:
        request["projectId"] = str(project_id)
    normalized_usage = canonical_usage(usage, budget_tokens)
    if normalized_usage:
        request["usage"] = normalized_usage
    return request, index_by_id


def observe_request(
    messages: list[dict[str, Any]],
    *,
    observation_id: str,
    session_id: str,
    observed_at_ms: int,
    usage: dict[str, Any] | None = None,
    context_limit_tokens: int = 0,
    model_key: str | None = None,
    project_id: str | None = None,
    turn_id: str | None = None,
    task_id: str | None = None,
    interrupted: bool = False,
    failed: bool = False,
    exit_reason: str | None = None,
    memory_candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    canonical, _ = snapshot_messages(messages)
    request: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "observationId": observation_id,
        "host": "hermes",
        "sessionId": session_id,
        "observedAtMs": max(0, int(observed_at_ms)),
        "messages": canonical,
        "outcome": {
            "interrupted": bool(interrupted),
            "failed": bool(failed),
        },
    }
    optional_strings = {
        "turnId": turn_id,
        "taskId": task_id,
        "modelKey": model_key,
        "projectId": project_id,
    }
    for key, value in optional_strings.items():
        if value:
            request[key] = str(value)
    if exit_reason:
        request["outcome"]["exitReason"] = str(exit_reason)
    normalized_usage = canonical_usage(usage, context_limit_tokens)
    if normalized_usage:
        request["usage"] = normalized_usage
    if memory_candidates:
        request["memoryCandidates"] = copy.deepcopy(memory_candidates)
    return request


def tool_execute_request(
    messages: list[dict[str, Any]],
    *,
    request_id: str,
    session_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    invoked_at_ms: int,
    model_key: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    canonical, _ = snapshot_messages(messages)
    request: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "host": "hermes",
        "sessionId": session_id,
        "toolName": tool_name,
        "arguments": copy.deepcopy(arguments),
        "messages": canonical,
        "invokedAtMs": max(0, int(invoked_at_ms)),
    }
    if model_key:
        request["modelKey"] = str(model_key)
    if project_id:
        request["projectId"] = str(project_id)
    return request


def lifecycle_request(
    *,
    event_id: str,
    session_id: str,
    action: str,
    observed_at_ms: int,
    messages: list[dict[str, Any]] | None = None,
    target_session_id: str | None = None,
    model_key: str | None = None,
    project_id: str | None = None,
    reason: str | None = None,
    auxiliary_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "eventId": event_id,
        "host": "hermes",
        "sessionId": session_id,
        "action": action,
        "observedAtMs": max(0, int(observed_at_ms)),
    }
    if messages is not None:
        request["messages"] = snapshot_messages(messages)[0]
    optional = {
        "targetSessionId": target_session_id,
        "modelKey": model_key,
        "projectId": project_id,
        "reason": reason,
    }
    for key, value in optional.items():
        if value:
            request[key] = str(value)
    if auxiliary_policy is not None:
        request["auxiliaryPolicy"] = copy.deepcopy(auxiliary_policy)
    return request


def maintenance_poll_request(
    *,
    poll_id: str,
    session_id: str,
    polled_at_ms: int,
    tasks: list[str] | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "pollId": poll_id,
        "host": "hermes",
        "sessionId": session_id,
        "polledAtMs": max(0, int(polled_at_ms)),
    }
    if tasks is not None:
        request["tasks"] = [str(task) for task in tasks]
    return request


def callback_resolution_request(
    callback: dict[str, Any],
    outcome: dict[str, Any],
    *,
    resolution_id: str,
    resolved_at_ms: int,
) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "resolutionId": resolution_id,
        "host": "hermes",
        "sessionId": str(callback["sessionId"]),
        "callbackId": str(callback["callbackId"]),
        "attempt": int(callback["attempt"]),
        "resolvedAtMs": max(0, int(resolved_at_ms)),
        "outcome": copy.deepcopy(outcome),
    }


def cache_feedback_request(
    *,
    event_id: str,
    session_id: str,
    observed_at_ms: int,
    usage: dict[str, Any],
    context_limit_tokens: int = 0,
    model_key: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "eventId": event_id,
        "host": "hermes",
        "sessionId": session_id,
        "observedAtMs": max(0, int(observed_at_ms)),
        "usage": canonical_usage(usage, context_limit_tokens),
    }
    if model_key:
        request["modelKey"] = str(model_key)
    if project_id:
        request["projectId"] = str(project_id)
    return request


def tool_event_request(
    *,
    event_id: str,
    session_id: str,
    observed_at_ms: int,
    phase: str,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    result: Any = None,
    status: str | None = None,
    duration_ms: int | float | None = None,
    tool_call_id: str | None = None,
    turn_id: str | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "eventId": event_id,
        "host": "hermes",
        "sessionId": session_id,
        "observedAtMs": max(0, int(observed_at_ms)),
        "phase": phase,
        "toolName": tool_name,
    }
    if arguments is not None:
        request["arguments"] = copy.deepcopy(arguments)
    if result is not None:
        serialized = _stable_json(result)
        request["result"] = result if len(serialized) <= 100_000 else {
            "truncated": True,
            "characters": len(serialized),
            "preview": serialized[:8_000],
        }
    if status:
        request["status"] = str(status)
    if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool):
        request["durationMs"] = max(0, duration_ms)
    optional = {
        "toolCallId": tool_call_id,
        "turnId": turn_id,
        "taskId": task_id,
    }
    for key, value in optional.items():
        if value:
            request[key] = str(value)
    return request


def _injection_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return _stable_json(content)


def _append_content(message: dict[str, Any], text: str, *, prepend: bool = False) -> None:
    content = message.get("content", "")
    if isinstance(content, str):
        separator = "\n\n" if content and text else ""
        message["content"] = text + separator + content if prepend else content + separator + text
        return
    if isinstance(content, list):
        block = {"type": "text", "text": text}
        if prepend:
            content.insert(0, block)
        else:
            content.append(block)
        return
    message["content"] = text


def _prefix_tag(value: Any, tag: str) -> str:
    text = value if isinstance(value, str) else _stable_json(value)
    return f"{tag} {_TAG_PREFIX.sub('', text)}"


def _mutate_content_value(
    message: dict[str, Any],
    content_index: int,
    operation: str,
    content: str | None,
) -> None:
    native = message.get("content", "")
    if isinstance(native, list):
        if not 0 <= content_index < len(native):
            raise InvalidContextPlanError("block mutation content index is invalid")
        if operation == "drop":
            native.pop(content_index)
            return
        raw = native[content_index]
        if isinstance(raw, dict) and raw.get("type") in {
            "text",
            "input_text",
            "output_text",
        }:
            raw["text"] = (
                _prefix_tag(raw.get("text", ""), str(content))
                if operation == "prefix_tag"
                else content
            )
        elif isinstance(raw, dict) and raw.get("type") in {"thinking", "reasoning"}:
            if "thinking" in raw and "text" not in raw:
                raw["thinking"] = content
            else:
                raw["text"] = content
        else:
            native[content_index] = {"type": "text", "text": content}
        return
    if content_index != 0:
        raise InvalidContextPlanError("block mutation content index is invalid")
    message["content"] = (
        _prefix_tag(message.get("content", ""), str(content))
        if operation == "prefix_tag"
        else "" if operation == "drop" else content
    )


def _mutate_block(
    message: dict[str, Any],
    canonical_message: dict[str, Any],
    block_id: str,
    operation: str,
    content: str | None,
) -> None:
    blocks = canonical_message.get("content")
    if not isinstance(blocks, list):
        raise InvalidContextPlanError("canonical message content is invalid")
    block_index = next(
        (
            index
            for index, block in enumerate(blocks)
            if isinstance(block, dict) and block.get("id") == block_id
        ),
        None,
    )
    if block_index is None:
        raise InvalidContextPlanError(f"mutation references unknown block {block_id}")

    if message.get("role") == "tool":
        if block_index != 0:
            raise InvalidContextPlanError("tool-result block index is invalid")
        message["content"] = (
            _prefix_tag(message.get("content", ""), str(content))
            if operation == "prefix_tag"
            else "" if operation == "drop" else content
        )
        return

    native_content = message.get("content", "")
    native_content_count = len(native_content) if isinstance(native_content, list) else 1
    if block_index < native_content_count:
        _mutate_content_value(message, block_index, operation, content)
        return

    tool_index = block_index - native_content_count
    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or not 0 <= tool_index < len(tool_calls):
        raise InvalidContextPlanError("block mutation tool-call index is invalid")
    if operation != "drop":
        raise InvalidContextPlanError("Hermes tool-call blocks only support drop")
    tool_calls.pop(tool_index)


def materialize_plan(
    messages: list[dict[str, Any]],
    request: dict[str, Any],
    index_by_id: dict[str, int],
    plan: dict[str, Any],
) -> list[dict[str, Any]]:
    if plan.get("protocolVersion") != PROTOCOL_VERSION:
        raise InvalidContextPlanError("unsupported ContextPlan protocolVersion")
    if plan.get("requestId") != request.get("requestId"):
        raise InvalidContextPlanError("ContextPlan requestId mismatch")
    decision = plan.get("decision")
    if decision not in {"serve", "defer", "safe_fallback", "block"}:
        raise InvalidContextPlanError(f"unknown ContextPlan decision {decision}")
    if decision == "block":
        raise InvalidContextPlanError("Hermes adapter does not advertise request blocking")
    accounting = plan.get("accounting")
    if not isinstance(accounting, dict):
        raise InvalidContextPlanError("ContextPlan accounting must be an object")
    estimated = accounting.get("estimatedInputTokens")
    hard_limit = accounting.get("hardLimitTokens")
    if not isinstance(estimated, (int, float)) or estimated < 0:
        raise InvalidContextPlanError("estimatedInputTokens must be non-negative")
    if not isinstance(hard_limit, (int, float)) or hard_limit < 0:
        raise InvalidContextPlanError("hardLimitTokens must be non-negative")
    retain = plan.get("retain")
    retain_ids = retain.get("messageIds") if isinstance(retain, dict) else None
    if not isinstance(retain_ids, list) or not all(isinstance(item, str) for item in retain_ids):
        raise InvalidContextPlanError("ContextPlan retain.messageIds must be a string array")
    if len(retain_ids) != len(set(retain_ids)):
        raise InvalidContextPlanError("ContextPlan contains duplicate retained messages")
    try:
        retained_indexes = sorted(index_by_id[message_id] for message_id in retain_ids)
    except KeyError as exc:
        raise InvalidContextPlanError(f"ContextPlan references unknown message {exc.args[0]}") from exc
    selected = [copy.deepcopy(messages[index]) for index in retained_indexes]

    mutations = plan.get("mutations", [])
    if not isinstance(mutations, list):
        raise InvalidContextPlanError("ContextPlan mutations must be an array")
    selected_by_original_index = {
        original_index: selected_index
        for selected_index, original_index in enumerate(retained_indexes)
    }
    for mutation in mutations:
        if not isinstance(mutation, dict) or not isinstance(mutation.get("target"), dict):
            raise InvalidContextPlanError("invalid ContextPlan mutation")
        target = mutation["target"]
        message_id = target.get("messageId")
        if not isinstance(message_id, str) or message_id not in index_by_id:
            raise InvalidContextPlanError("mutation references an unknown message")
        original_index = index_by_id[message_id]
        if original_index not in selected_by_original_index:
            continue
        selected_index = selected_by_original_index[original_index]
        operation = mutation.get("operation")
        content = mutation.get("content")
        if operation in {"replace", "truncate_tool", "edit_marker", "prefix_tag"} and not isinstance(
            content, str
        ):
            raise InvalidContextPlanError(f"{operation} mutation requires string content")
        block_id = target.get("blockId")
        block_index = target.get("blockIndex")
        if block_id is not None and block_index is not None:
            raise InvalidContextPlanError("mutation target cannot use blockId and blockIndex")
        if block_index is not None:
            if not isinstance(block_index, int) or block_index < 0:
                raise InvalidContextPlanError("mutation blockIndex must be non-negative")
            canonical_blocks = request["messages"][original_index].get("content", [])
            if not isinstance(canonical_blocks, list) or block_index >= len(canonical_blocks):
                raise InvalidContextPlanError("mutation blockIndex is invalid")
            candidate_id = canonical_blocks[block_index].get("id")
            if not isinstance(candidate_id, str):
                raise InvalidContextPlanError("canonical blockIndex has no materializable id")
            block_id = candidate_id
        if block_id is not None:
            if not isinstance(block_id, str):
                raise InvalidContextPlanError("mutation blockId must be a string")
            selected_message = selected[selected_index]
            if not isinstance(selected_message, dict):
                continue
            canonical_message = request["messages"][original_index]
            _mutate_block(
                selected_message,
                canonical_message,
                block_id,
                str(operation),
                content if isinstance(content, str) else None,
            )
            continue
        if operation == "drop":
            selected[selected_index] = None
        elif operation in {"replace", "truncate_tool", "edit_marker"}:
            selected[selected_index]["content"] = content
        else:
            raise InvalidContextPlanError(f"unknown ContextPlan mutation {operation}")
    selected = [message for message in selected if isinstance(message, dict)]

    injections = plan.get("injections", [])
    if not isinstance(injections, list):
        raise InvalidContextPlanError("ContextPlan injections must be an array")
    injection_keys: set[tuple[str, int]] = set()
    for injection in injections:
        if not isinstance(injection, dict):
            raise InvalidContextPlanError("invalid ContextPlan injection")
        slot = injection.get("slot")
        epoch = injection.get("epoch")
        if slot not in _INJECTION_ORDER:
            raise InvalidContextPlanError(f"unknown ContextPlan injection slot {slot}")
        if not isinstance(epoch, int) or epoch < 0:
            raise InvalidContextPlanError("ContextPlan injection epoch must be non-negative")
        if not isinstance(injection.get("fingerprint"), str):
            raise InvalidContextPlanError("ContextPlan injection fingerprint must be a string")
        key = (slot, epoch)
        if key in injection_keys:
            raise InvalidContextPlanError(f"duplicate ContextPlan injection identity {key}")
        injection_keys.add(key)
    ordered = sorted(
        injections,
        key=lambda item: (_INJECTION_ORDER.get(item.get("slot"), 99), int(item.get("epoch", 0))),
    )
    for injection in ordered:
        slot = injection.get("slot")
        text = _injection_text(injection.get("content", ""))
        if slot == "stable_prefix":
            target = next((message for message in selected if message.get("role") == "system"), None)
            if target is None:
                target = {"role": "system", "content": ""}
                selected.insert(0, target)
            _append_content(target, text)
        elif slot == "volatile_delta":
            target = next((message for message in selected if message.get("role") == "user"), None)
            if target is None:
                target = {"role": "user", "content": ""}
                insert_at = 1 if selected and selected[0].get("role") == "system" else 0
                selected.insert(insert_at, target)
            _append_content(target, text, prepend=True)
        elif slot == "tail_nudge":
            target = next(
                (message for message in reversed(selected) if message.get("role") == "user"),
                None,
            )
            if target is None:
                selected.append({"role": "user", "content": text})
            else:
                _append_content(target, text)
        else:
            raise InvalidContextPlanError(f"unknown ContextPlan injection slot {slot}")
    return selected


def _turn_segments(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    segments: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "user" and current:
            segments.append(current)
            current = []
        current.append(message)
    if current:
        segments.append(current)
    return segments


def _truncate_text(value: Any, max_chars: int) -> Any:
    if not isinstance(value, str) or len(value) <= max_chars:
        return value
    head = max_chars * 2 // 3
    tail = max_chars - head
    return value[:head] + _TRUNCATION_MARKER + value[-tail:]


def safe_fallback(
    messages: list[dict[str, Any]],
    budget_tokens: int,
    *,
    target_fraction: float = 0.82,
) -> list[dict[str, Any]]:
    """Return a deterministic bounded tail without relying on host failure semantics."""
    if not messages:
        return []
    effective_budget = max(512, int((budget_tokens or 16_000) * target_fraction))
    if estimate_tokens(messages) <= effective_budget:
        return copy.deepcopy(messages)

    system = [copy.deepcopy(message) for message in messages if message.get("role") == "system"]
    body = [message for message in messages if message.get("role") != "system"]
    segments = _turn_segments(body)
    selected_segments: list[list[dict[str, Any]]] = []
    for segment in reversed(segments):
        candidate = system + [
            copy.deepcopy(message)
            for part in reversed([segment] + selected_segments)
            for message in part
        ]
        if selected_segments and estimate_tokens(candidate) > effective_budget:
            break
        selected_segments.insert(0, segment)
    selected = system + [
        copy.deepcopy(message) for segment in selected_segments for message in segment
    ]

    # First reclaim tool payloads while preserving tool-call/result structure.
    for message in selected:
        if estimate_tokens(selected) <= effective_budget:
            break
        if message.get("role") == "tool":
            message["content"] = "[tool result omitted by Magic Context safe fallback]"

    # Then bound older text. The newest user message is processed last.
    latest_user_index = next(
        (index for index in range(len(selected) - 1, -1, -1) if selected[index].get("role") == "user"),
        -1,
    )
    order = [index for index in range(len(selected)) if index != latest_user_index]
    if latest_user_index >= 0:
        order.append(latest_user_index)
    for index in order:
        if estimate_tokens(selected) <= effective_budget:
            break
        if selected[index].get("role") == "system":
            continue
        content = selected[index].get("content")
        if isinstance(content, str):
            selected[index]["content"] = _truncate_text(content, 2_000)

    return selected
