#!/usr/bin/env python3
"""Opt-in live Hermes/provider/session smoke test for Magic Context.

Required environment variables:

* MAGIC_CONTEXT_LIVE_API_KEY
* MAGIC_CONTEXT_LIVE_MODEL

The credential is passed directly to ``AIAgent``. It is never written to the
temporary Hermes config, runtime command, result summary, or repository.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import time
import uuid


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
HERMES_ROOT = Path(
    os.environ.get(
        "MAGIC_CONTEXT_HERMES_ROOT", str(PLUGIN_ROOT.parents[2] / "hermes-agent")
    )
).resolve()
RUNTIME_CLI = Path(
    os.environ.get(
        "MAGIC_CONTEXT_RUNTIME_CLI",
        str(PLUGIN_ROOT.parent / "runtime" / "dist" / "cli.js"),
    )
).resolve()
EXPECTED_TOOLS = {
    "ctx_status",
    "ctx_search",
    "ctx_memory",
    "ctx_expand",
    "ctx_reduce",
    "ctx_note",
}
PROVIDER_REQUIRED_TOOLS = {"ctx_search", "ctx_memory", "ctx_note"}


class LiveE2EFailure(RuntimeError):
    """A sanitized integration invariant failed."""


def _tool_names(messages: list[dict]) -> set[str]:
    names: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if isinstance(function, dict) and function.get("name"):
                names.add(str(function["name"]))
    return names


def _assert_secret_not_persisted(root: Path, secret: str) -> None:
    needle = secret.encode("utf-8")
    for path in root.rglob("*"):
        if not path.is_file() or path.stat().st_size > 20_000_000:
            continue
        if needle in path.read_bytes():
            raise LiveE2EFailure(f"credential was persisted under temporary Hermes home: {path.name}")


def _wait_for_observation(engine: object, timeout_seconds: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not getattr(engine, "_observe_worker_active", False):
            return
        time.sleep(0.05)
    raise LiveE2EFailure("turn.observe did not drain before the live-test deadline")


def _write_isolated_config(home: Path, model: str, base_url: str) -> None:
    import yaml

    config = {
        "model": {
            "default": model,
            "provider": "custom",
            "base_url": base_url,
            "context_length": 131_072,
            "max_tokens": 768,
        },
        "context": {"engine": "magic-context"},
        "compression": {"enabled": False},
        "auxiliary": {
            task: {
                "provider": "custom",
                "model": model,
                "base_url": base_url,
                "key_env": "MAGIC_CONTEXT_LIVE_API_KEY",
                "api_mode": "chat_completions",
            }
            for task in (
                "magic_context_historian",
                "magic_context_dreamer",
                "magic_context_sidekick",
            )
        },
        "plugins": {
            "enabled": ["magic-context"],
            "entries": {
                "magic-context": {
                    "settings": {
                        "historian_enabled": True,
                        "historian_threshold_percentage": 0,
                        "historian_min_messages": 4,
                        "historian_protected_tail_messages": 2,
                        "dreamer_enabled": True,
                        "dreamer_interval_ms": 0,
                        "sidekick_enabled": True,
                        "auxiliary_max_attempts": 2,
                    }
                }
            },
        },
    }
    (home / "config.yaml").write_text(
        yaml.safe_dump(config, sort_keys=False),
        encoding="utf-8",
    )


def _sanitized_error(stage: str, exc: BaseException) -> dict[str, object]:
    result: dict[str, object] = {
        "ok": False,
        "stage": stage,
        "error_type": type(exc).__name__,
        "status_code": getattr(exc, "status_code", None),
    }
    if isinstance(exc, LiveE2EFailure):
        result["detail"] = str(exc)
    return result


def main() -> int:
    api_key = os.environ.get("MAGIC_CONTEXT_LIVE_API_KEY", "").strip()
    model = os.environ.get("MAGIC_CONTEXT_LIVE_MODEL", "").strip()
    base_url = (
        os.environ.get("MAGIC_CONTEXT_LIVE_BASE_URL", "").strip()
        or "https://agentrouter.org/v1"
    )
    if not api_key or not model:
        print(
            json.dumps(
                {
                    "ok": False,
                    "skipped": True,
                    "reason": (
                        "set MAGIC_CONTEXT_LIVE_API_KEY and "
                        "MAGIC_CONTEXT_LIVE_MODEL"
                    ),
                }
            )
        )
        return 2
    if not HERMES_ROOT.exists() or not RUNTIME_CLI.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "skipped": True,
                    "reason": "sibling Hermes checkout and built runtime are required",
                }
            )
        )
        return 2
    node = shutil.which("node")
    if not node:
        print(json.dumps({"ok": False, "skipped": True, "reason": "node is required"}))
        return 2

    stage = "setup"
    agent = None
    with tempfile.TemporaryDirectory(prefix="magic-context-live-") as raw_home:
        home = Path(raw_home)
        plugin_target = home / "plugins" / "magic-context"
        shutil.copytree(
            PLUGIN_ROOT,
            plugin_target,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"),
        )
        _write_isolated_config(home, model, base_url)
        runtime_state = home / "magic-context-state"
        os.environ["HERMES_HOME"] = str(home)
        os.environ["MAGIC_CONTEXT_RUNTIME_COMMAND"] = shlex.join(
            (node, str(RUNTIME_CLI), "--state-dir", str(runtime_state))
        )

        try:
            stage = "hermes_init"
            sys.path.insert(0, str(HERMES_ROOT))
            from run_agent import AIAgent

            session_id = f"magic-context-live-{uuid.uuid4().hex[:12]}"
            marker = f"MC_E2E_{uuid.uuid4().hex[:12]}"
            agent = AIAgent(
                base_url=base_url,
                api_key=api_key,
                provider="custom",
                requested_provider="custom",
                api_mode="chat_completions",
                model=model,
                max_iterations=8,
                max_tokens=768,
                enabled_toolsets=["context_engine"],
                quiet_mode=True,
                session_id=session_id,
                skip_context_files=True,
                skip_memory=True,
                skip_background_review=True,
            )
            engine = agent.context_compressor
            if getattr(engine, "name", "") != "magic-context":
                raise LiveE2EFailure("Hermes did not select the magic-context engine")
            if (
                engine.auxiliary_policy.get("historianThresholdPercentage") != 0
                or engine.auxiliary_policy.get("historianMinMessages") != 4
                or not engine.auxiliary_policy.get("sidekickEnabled")
            ):
                raise LiveE2EFailure("Hermes did not apply plugin auxiliary settings")
            registered_tools = set(getattr(agent, "_context_engine_tool_names", set()))
            if registered_tools != EXPECTED_TOOLS:
                raise LiveE2EFailure("Hermes did not register the complete context tool surface")

            stage = "provider_turn"
            result = agent.run_conversation(
                (
                    "This is a deterministic integration test. Use the context tools and no "
                    "other tools. First call ctx_note with action=write, content="
                    f"'{marker} ready after search', and surface_condition='tool:ctx_search'. "
                    "Then call ctx_memory with action=write, category=CONFIG_VALUES, and "
                    f"content='{marker} provider session verified'. Then call ctx_search with "
                    f"query='{marker}' and sources=['memory','note']. After all three tool "
                    "results, reply with exactly MAGIC_CONTEXT_E2E_OK."
                )
            )
            messages = result.get("messages")
            if not isinstance(messages, list):
                raise LiveE2EFailure("Hermes returned no conversation transcript")
            provider_tools = _tool_names(messages)
            if not PROVIDER_REQUIRED_TOOLS.issubset(provider_tools):
                raise LiveE2EFailure("provider did not invoke the required context tools")
            if "MAGIC_CONTEXT_E2E_OK" not in str(result.get("final_response") or ""):
                raise LiveE2EFailure("provider did not finish the instructed tool sequence")

            stage = "runtime_session"
            expand_result = engine.handle_tool_call(
                "ctx_expand", {"message": 1}, messages=messages
            )
            reduce_result = engine.handle_tool_call(
                "ctx_reduce", {"drop": "1"}, messages=messages
            )
            if "Error:" in expand_result or "Error:" in reduce_result:
                raise LiveE2EFailure("runtime expand/reduce round trip failed")
            clone_id = f"{session_id}-clone"
            engine.carry_over_new_session_context(session_id, clone_id)
            engine.observe_session_reset(clone_id, reason="live_e2e_reset")
            engine.on_session_delete(clone_id, reason="live_e2e_delete")
            engine.on_session_end(session_id, messages)
            _wait_for_observation(engine)
            if not any(runtime_state.rglob("*.json")):
                raise LiveE2EFailure("runtime did not persist session state")
            runtime_documents = []
            for path in runtime_state.glob("*.json"):
                try:
                    runtime_documents.append(json.loads(path.read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    continue
            auxiliary_states = [
                document.get("auxiliary")
                for document in runtime_documents
                if isinstance(document, dict)
                and isinstance(document.get("auxiliary"), dict)
            ]
            if not any(
                state.get("historianLastSuccessAtMs") for state in auxiliary_states
            ):
                diagnostics = [
                    {
                        "failure_count": state.get("historianFailureCount"),
                        "last_error": state.get("historianLastError"),
                        "jobs": [
                            {
                                "task": job.get("task"),
                                "status": job.get("status"),
                                "attempts": job.get("attempts"),
                                "last_error": job.get("lastError"),
                            }
                            for job in state.get("jobs", [])
                            if isinstance(job, dict)
                        ],
                    }
                    for state in auxiliary_states
                ]
                raise LiveE2EFailure(
                    "Historian callback was not validated and persisted: "
                    + json.dumps(diagnostics, sort_keys=True)
                )
            if not any(
                state.get("dreamerLastSuccessAtMs") for state in auxiliary_states
            ):
                raise LiveE2EFailure("Dreamer callback did not complete")
            _assert_secret_not_persisted(home, api_key)

            status = engine.get_status()
            if status.get("auxiliary_callbacks_completed", 0) < 2:
                raise LiveE2EFailure("Hermes did not execute the auxiliary callback chain")
            print(
                json.dumps(
                    {
                        "ok": True,
                        "model": model,
                        "engine": status.get("engine"),
                        "provider_tool_calls": sorted(provider_tools),
                        "api_calls": result.get("api_calls"),
                        "input_tokens": result.get("input_tokens"),
                        "output_tokens": result.get("output_tokens"),
                        "cache_read_tokens": status.get("cache_read_tokens"),
                        "cache_write_tokens": status.get("cache_write_tokens"),
                        "runtime_failures": status.get("runtime_failures"),
                        "auxiliary_callbacks_completed": status.get(
                            "auxiliary_callbacks_completed"
                        ),
                        "auxiliary_callback_timeouts": status.get(
                            "auxiliary_callback_timeouts"
                        ),
                        "auxiliary_callback_failures": status.get(
                            "auxiliary_callback_failures"
                        ),
                    },
                    sort_keys=True,
                )
            )
            return 0
        except Exception as exc:
            print(json.dumps(_sanitized_error(stage, exc), sort_keys=True))
            return 1
        finally:
            if agent is not None:
                client = getattr(agent, "client", None)
                close = getattr(client, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:
                        pass


if __name__ == "__main__":
    raise SystemExit(main())
