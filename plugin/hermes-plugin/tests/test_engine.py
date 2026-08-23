from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_CLI = PLUGIN_ROOT.parent / "runtime" / "dist" / "cli.js"
HERMES_ROOT = PLUGIN_ROOT.parents[2] / "hermes-agent"
if HERMES_ROOT.exists():
    sys.path.insert(0, str(HERMES_ROOT))
else:
    # Keep adapter tests runnable in a standalone Magic Context checkout. The
    # real Hermes ABC contract is exercised automatically when the sibling
    # repository is present, as it is in the integration workspace.
    agent_module = types.ModuleType("agent")
    context_engine_module = types.ModuleType("agent.context_engine")

    class ContextEngine:
        pass

    context_engine_module.ContextEngine = ContextEngine
    agent_module.context_engine = context_engine_module
    sys.modules["agent"] = agent_module
    sys.modules["agent.context_engine"] = context_engine_module

spec = importlib.util.spec_from_file_location(
    "magic_context_hermes",
    PLUGIN_ROOT / "__init__.py",
    submodule_search_locations=[str(PLUGIN_ROOT)],
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

MagicContextEngine = module.MagicContextEngine
adapter = sys.modules["magic_context_hermes.hermes_adapter"]


class FakeRuntime:
    def __init__(self, responder=None, *, failure=None):
        self.responder = responder
        self.failure = failure
        self.calls = []
        self.available = True

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if self.failure:
            raise self.failure
        return self.responder(method, params) if self.responder else None


class FakeLlm:
    def __init__(self, *, text="focused context", parsed=None, failure=None):
        self.text = text
        self.parsed = parsed
        self.failure = failure
        self.calls = []

    def _result(self):
        if self.failure:
            raise self.failure
        return types.SimpleNamespace(
            text=self.text,
            parsed=copy.deepcopy(self.parsed),
            provider="test-provider",
            model="test-model",
            usage=types.SimpleNamespace(
                input_tokens=10,
                output_tokens=5,
                cache_read_tokens=2,
                cache_write_tokens=1,
            ),
        )

    def complete(self, messages, **kwargs):
        self.calls.append(("complete", copy.deepcopy(messages), copy.deepcopy(kwargs)))
        return self._result()

    def complete_structured(self, **kwargs):
        self.calls.append(("structured", copy.deepcopy(kwargs)))
        return self._result()


def callback(task, request, *, callback_id="callback-1", attempt=1, deadline=None):
    return {
        "protocolVersion": 1,
        "callbackId": callback_id,
        "kind": "auxiliary_llm",
        "host": "hermes",
        "sessionId": "session-callback",
        "task": task,
        "taskKey": f"magic_context_{task}",
        "purpose": f"{task} test",
        "createdAtMs": int(time.time() * 1000),
        "deadlineAtMs": (
            deadline if deadline is not None else int(time.time() * 1000) + 60_000
        ),
        "attempt": attempt,
        "request": request,
    }


class MagicContextEngineTests(unittest.TestCase):
    def test_register_declares_auxiliary_tasks_and_context_engine(self):
        class FakeContext:
            def __init__(self):
                self.llm = object()
                self.tasks = []
                self.engine = None
                self.hooks = {}
                self.cli_commands = []

            def register_auxiliary_task(self, **kwargs):
                self.tasks.append(kwargs)

            def register_context_engine(self, engine):
                self.engine = engine

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def register_cli_command(self, *args, **kwargs):
                self.cli_commands.append((args, kwargs))

        context = FakeContext()
        module.register(context)
        self.assertEqual(
            [task["key"] for task in context.tasks],
            [
                "magic_context_historian",
                "magic_context_dreamer",
                "magic_context_sidekick",
            ],
        )
        self.assertIsInstance(context.engine, MagicContextEngine)
        self.assertTrue(context.engine.auxiliary_policy["historianEnabled"])
        self.assertFalse(context.engine.auxiliary_policy["sidekickEnabled"])
        self.assertEqual(context.tasks[0]["defaults"]["timeout"], 600)
        self.assertEqual(context.cli_commands[0][0][0], "magic-context")
        self.assertEqual(
            set(context.hooks),
            {"pre_tool_call", "post_tool_call", "on_session_reset", "on_session_finalize"},
        )

    def test_engine_implements_the_real_hermes_context_contract(self):
        from agent.context_engine import ContextEngine

        self.assertIsInstance(MagicContextEngine(), ContextEngine)

    def test_snapshot_ids_are_deterministic(self):
        messages = [
            {"role": "user", "content": "same"},
            {"role": "user", "content": "same"},
        ]
        first, _ = adapter.snapshot_messages(messages)
        second, _ = adapter.snapshot_messages(messages)
        self.assertEqual(first, second)
        self.assertNotEqual(first[0]["id"], first[1]["id"])

    def test_tool_results_are_not_duplicated_in_the_canonical_snapshot(self):
        canonical, _ = adapter.snapshot_messages(
            [{"role": "tool", "tool_call_id": "call-1", "content": "result"}]
        )
        self.assertEqual(len(canonical[0]["content"]), 1)
        self.assertEqual(canonical[0]["content"][0]["kind"], "tool_result")

    def test_snapshot_matches_cross_host_adapter_golden(self):
        expected = json.loads(
            (PLUGIN_ROOT.parent / "e2e" / "adapter-golden.json").read_text(
                encoding="utf8"
            )
        )["semanticBlocks"]
        canonical, _ = adapter.snapshot_messages(
            [
                {"role": "user", "content": "inspect this"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "read",
                                "arguments": '{"path":"a.txt"}',
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "name": "read",
                    "content": "contents",
                },
            ]
        )
        actual = []
        for message in canonical:
            for block in message["content"]:
                if block["kind"] == "text" and block["text"]:
                    actual.append(
                        {
                            "role": message["role"],
                            "kind": "text",
                            "value": block["text"],
                        }
                    )
                elif block["kind"] == "tool_call":
                    actual.append(
                        {
                            "role": "assistant",
                            "kind": "tool_call",
                            "callId": block["callId"],
                            "name": block["name"],
                            "value": block["input"],
                        }
                    )
                elif block["kind"] == "tool_result":
                    actual.append(
                        {
                            "role": "tool",
                            "kind": "tool_result",
                            "callId": block["callId"],
                            "name": block.get("name"),
                            "value": block["output"],
                        }
                    )
        self.assertEqual(actual, expected)

    def test_in_budget_without_runtime_is_byte_equivalent(self):
        messages = [
            {"role": "system", "content": "base"},
            {"role": "user", "content": "hello"},
        ]
        engine = MagicContextEngine(context_length=10_000)
        self.assertEqual(
            engine.select_context(messages, budget_tokens=10_000),
            messages,
        )

    def test_materializes_stable_and_volatile_slots_in_hermes_layout(self):
        def responder(method, request):
            self.assertEqual(method, "context.compose")
            ids = [message["id"] for message in request["messages"]]
            return {
                "protocolVersion": 1,
                "requestId": request["requestId"],
                "decision": "serve",
                "retain": {"messageIds": ids},
                "mutations": [],
                "injections": [
                    {
                        "slot": "volatile_delta",
                        "content": "M1",
                        "epoch": 2,
                        "fingerprint": "m1",
                    },
                    {
                        "slot": "stable_prefix",
                        "content": "M0",
                        "epoch": 1,
                        "fingerprint": "m0",
                    },
                ],
                "accounting": {
                    "estimatedInputTokens": 10,
                    "hardLimitTokens": 1000,
                    "cacheDecision": "hit_safe",
                },
            }

        engine = MagicContextEngine(runtime=FakeRuntime(responder), context_length=1000)
        messages = [
            {"role": "system", "content": "base"},
            {"role": "user", "content": "question"},
        ]
        selected = engine.select_context(messages, budget_tokens=1000)
        self.assertEqual(selected[0]["content"], "base\n\nM0")
        self.assertEqual(selected[1]["content"], "M1\n\nquestion")
        self.assertEqual(messages[0]["content"], "base")

    def test_over_budget_runtime_failure_returns_bounded_tool_safe_tail(self):
        runtime_error = module.RuntimeBridgeError("offline")
        engine = MagicContextEngine(
            runtime=FakeRuntime(failure=runtime_error),
            context_length=1200,
        )
        messages = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "old" * 5000},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "read", "arguments": "{}"},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call-1",
                "content": "result" * 5000,
            },
            {"role": "user", "content": "latest question"},
        ]
        selected = engine.select_context(messages, budget_tokens=1200)
        self.assertEqual(selected[0]["role"], "system")
        self.assertEqual(selected[-1]["content"], "latest question")
        self.assertLess(len(selected), len(messages))
        self.assertLessEqual(adapter.estimate_tokens(selected), 1200)
        self.assertEqual(engine.get_status()["runtime_failures"], 1)

    def test_status_tool_reports_runtime_state(self):
        engine = MagicContextEngine(context_length=4000)
        result = json.loads(engine.handle_tool_call("ctx_status", {}))
        self.assertEqual(result["engine"], "magic-context")
        self.assertFalse(result["runtime_available"])

    def test_registers_the_complete_context_tool_surface(self):
        engine = MagicContextEngine()
        self.assertEqual(
            [schema["name"] for schema in engine.get_tool_schemas()],
            [
                "ctx_status",
                "ctx_search",
                "ctx_memory",
                "ctx_expand",
                "ctx_reduce",
                "ctx_note",
            ],
        )

    def test_materializes_block_level_text_and_tool_result_mutations(self):
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "id": "first", "text": "replace me"},
                    {"type": "text", "id": "second", "text": "keep me"},
                ],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": "huge result"},
        ]
        request, indexes = adapter.compose_request(
            messages,
            request_id="blocks",
            session_id="session",
            budget_tokens=1000,
        )
        first_message = request["messages"][0]
        tool_message = request["messages"][1]
        plan = {
            "protocolVersion": 1,
            "requestId": "blocks",
            "decision": "serve",
            "retain": {"messageIds": [first_message["id"], tool_message["id"]]},
            "mutations": [
                {
                    "target": {
                        "messageId": first_message["id"],
                        "blockId": first_message["content"][0]["id"],
                    },
                    "operation": "replace",
                    "content": "bounded text",
                },
                {
                    "target": {
                        "messageId": tool_message["id"],
                        "blockId": tool_message["content"][0]["id"],
                    },
                    "operation": "truncate_tool",
                    "content": "bounded result",
                },
                {
                    "target": {
                        "messageId": first_message["id"],
                        "blockIndex": 0,
                    },
                    "operation": "prefix_tag",
                    "content": "§7§",
                },
                {
                    "target": {
                        "messageId": tool_message["id"],
                        "blockId": tool_message["content"][0]["id"],
                    },
                    "operation": "prefix_tag",
                    "content": "§8§",
                },
            ],
            "injections": [],
            "accounting": {
                "estimatedInputTokens": 20,
                "hardLimitTokens": 1000,
                "cacheDecision": "bust_required",
            },
        }

        selected = adapter.materialize_plan(messages, request, indexes, plan)
        self.assertEqual(selected[0]["content"][0]["text"], "§7§ bounded text")
        self.assertEqual(selected[0]["content"][1]["text"], "keep me")
        self.assertEqual(selected[1]["content"], "§8§ bounded result")
        self.assertEqual(messages[0]["content"][0]["text"], "replace me")

    def test_context_tools_are_forwarded_to_the_runtime(self):
        def responder(method, request):
            self.assertEqual(method, "tool.execute")
            self.assertEqual(request["toolName"], "ctx_search")
            self.assertEqual(request["arguments"], {"query": "lunar"})
            self.assertEqual(request["messages"][0]["ordinal"], 1)
            return {
                "protocolVersion": 1,
                "requestId": request["requestId"],
                "sessionId": request["sessionId"],
                "toolName": "ctx_search",
                "ok": True,
                "output": "one result",
                "revision": 1,
            }

        engine = MagicContextEngine(runtime=FakeRuntime(responder))
        engine.session_id = "session-tools"
        result = engine.handle_tool_call(
            "ctx_search",
            {"query": "lunar"},
            messages=[{"role": "user", "content": "find lunar"}],
        )
        self.assertEqual(result, "one result")

    def test_turn_observe_sends_a_canonical_idempotent_observation(self):
        observed = threading.Event()

        def responder(method, request):
            if method == "session.lifecycle":
                return {
                    "protocolVersion": 1,
                    "eventId": request["eventId"],
                    "sessionId": request["sessionId"],
                    "action": request["action"],
                    "accepted": True,
                    "revision": 1,
                }
            if method == "maintenance.poll":
                return {
                    "protocolVersion": 1,
                    "pollId": request["pollId"],
                    "sessionId": request["sessionId"],
                    "revision": 1,
                    "callbacks": [],
                }
            self.assertEqual(method, "turn.observe")
            self.assertEqual(request["observationId"], "turn-7")
            self.assertEqual(request["sessionId"], "session-7")
            self.assertEqual(request["projectId"], "project-a")
            self.assertEqual(request["messages"][0]["role"], "user")
            self.assertEqual(request["messages"][0]["content"][0]["kind"], "text")
            self.assertEqual(request["usage"]["inputTokens"], 120)
            self.assertEqual(request["usage"]["contextLimitTokens"], 4000)
            self.assertEqual(request["outcome"]["exitReason"], "complete")
            self.assertEqual(
                request["memoryCandidates"][0]["category"], "PROJECT_RULES"
            )
            observed.set()
            return {
                "protocolVersion": 1,
                "observationId": "turn-7",
                "sessionId": "session-7",
                "accepted": True,
                "revision": 1,
                "observedAtMs": request["observedAtMs"],
            }

        runtime = FakeRuntime(responder)
        engine = MagicContextEngine(runtime=runtime, context_length=4000)
        engine.on_session_start(
            "session-7", model="openai/test", project_id="project-a"
        )
        engine.on_turn_complete(
            [{"role": "user", "content": "hello"}],
            {"input_tokens": 120, "output_tokens": 8},
            turn_id="turn-7",
            turn_exit_reason="complete",
            memory_candidates=[
                {
                    "category": "PROJECT_RULES",
                    "content": "Use Bun for package scripts.",
                }
            ],
        )

        self.assertTrue(observed.wait(1.0))

    def test_turn_observe_serializes_completed_turns_without_dropping_them(self):
        first_started = threading.Event()
        release_first = threading.Event()
        second_finished = threading.Event()

        def responder(method, request):
            if method == "session.lifecycle":
                return {
                    "protocolVersion": 1,
                    "eventId": request["eventId"],
                    "sessionId": request["sessionId"],
                    "action": request["action"],
                    "accepted": True,
                    "revision": 1,
                }
            if method == "maintenance.poll":
                return {
                    "protocolVersion": 1,
                    "pollId": request["pollId"],
                    "sessionId": request["sessionId"],
                    "revision": 1,
                    "callbacks": [],
                }
            self.assertEqual(method, "turn.observe")
            if request["observationId"] == "turn-1":
                first_started.set()
                self.assertTrue(release_first.wait(1.0))
            if request["observationId"] == "turn-2":
                second_finished.set()
            return {
                "protocolVersion": 1,
                "observationId": request["observationId"],
                "sessionId": request["sessionId"],
                "accepted": True,
                "revision": 1,
                "observedAtMs": request["observedAtMs"],
            }

        runtime = FakeRuntime(responder)
        engine = MagicContextEngine(runtime=runtime, context_length=4000)
        engine.on_session_start("session-queue")
        engine.on_turn_complete(
            [{"role": "user", "content": "first"}],
            {"input_tokens": 10},
            turn_id="turn-1",
        )
        self.assertTrue(first_started.wait(1.0))
        engine.on_turn_complete(
            [{"role": "user", "content": "second"}],
            {"input_tokens": 20},
            turn_id="turn-2",
        )
        release_first.set()

        self.assertTrue(second_finished.wait(1.0))
        self.assertEqual(
            [request["observationId"] for method, request in runtime.calls if method == "turn.observe"],
            ["turn-1", "turn-2"],
        )

    def test_cache_and_tool_events_feed_the_runtime(self):
        runtime = FakeRuntime(lambda method, request: {"accepted": True})
        engine = MagicContextEngine(runtime=runtime, context_length=1000)
        engine.session_id = "session-events"
        engine.update_from_response(
            {
                "input_tokens": 700,
                "cache_read_tokens": 100,
                "cache_write_tokens": 50,
            }
        )
        engine.observe_tool_event(
            "post",
            session_id="session-events",
            tool_name="read_file",
            tool_call_id="call-1",
            result="x" * 9000,
            status="ok",
        )

        self.assertEqual([method for method, _ in runtime.calls], ["cache.observe", "tool.observe"])
        self.assertEqual(runtime.calls[0][1]["usage"]["cacheReadTokens"], 100)
        self.assertEqual(runtime.calls[1][1]["phase"], "post")

    def test_sidekick_callback_runs_through_hermes_llm_before_materialization(self):
        compose_count = 0
        resolved = []
        sidekick = callback(
            "sidekick",
            {
                "mode": "complete",
                "messages": [
                    {"role": "system", "content": "retrieve"},
                    {"role": "user", "content": "find the rule"},
                ],
                "temperature": 0.1,
                "maxTokens": 100,
            },
        )

        def responder(method, request):
            nonlocal compose_count
            if method == "context.compose":
                compose_count += 1
                ids = [message["id"] for message in request["messages"]]
                plan = {
                    "protocolVersion": 1,
                    "requestId": request["requestId"],
                    "decision": "serve",
                    "retain": {"messageIds": ids},
                    "mutations": [],
                    "injections": [],
                    "accounting": {
                        "estimatedInputTokens": 20,
                        "hardLimitTokens": 1000,
                        "cacheDecision": "bust_required",
                    },
                }
                if compose_count == 1:
                    plan["callbacks"] = [sidekick]
                else:
                    plan["injections"] = [
                        {
                            "slot": "tail_nudge",
                            "content": "<sidekick-augmentation>focused context</sidekick-augmentation>",
                            "epoch": 2,
                            "fingerprint": "sidekick-result",
                        }
                    ]
                return plan
            if method == "host.callback.resolve":
                resolved.append(copy.deepcopy(request))
                return {
                    "protocolVersion": 1,
                    "resolutionId": request["resolutionId"],
                    "callbackId": request["callbackId"],
                    "sessionId": request["sessionId"],
                    "accepted": True,
                    "status": "completed",
                    "revision": 2,
                }
            self.fail(f"unexpected runtime method {method}")

        llm = FakeLlm(text="focused context")
        engine = MagicContextEngine(
            runtime=FakeRuntime(responder), llm=llm, context_length=1000
        )
        engine.session_id = "session-callback"
        selected = engine.select_context(
            [{"role": "user", "content": "find the rule"}], budget_tokens=1000
        )

        self.assertEqual(compose_count, 2)
        self.assertEqual(llm.calls[0][0], "complete")
        self.assertEqual(llm.calls[0][2]["task"], "magic_context_sidekick")
        self.assertEqual(resolved[0]["outcome"]["status"], "completed")
        self.assertEqual(resolved[0]["outcome"]["usage"]["cacheReadTokens"], 2)
        self.assertIn("focused context", selected[0]["content"])
        self.assertEqual(engine.get_status()["auxiliary_callbacks_completed"], 1)

    def test_historian_callback_uses_structured_llm_and_returns_parsed_output(self):
        parsed = {
            "compartments": [
                {
                    "startOrdinal": 2,
                    "endOrdinal": 8,
                    "title": "work",
                    "episodeType": "implementation",
                    "importance": 90,
                    "p1": "full",
                    "p2": "medium",
                    "p3": "short",
                    "p4": "anchor",
                }
            ],
            "memoryCandidates": [],
        }
        historian = callback(
            "historian",
            {
                "mode": "structured",
                "instructions": "summarize",
                "input": [{"type": "text", "text": "transcript"}],
                "jsonSchema": {"type": "object"},
                "schemaName": "historian_output",
                "systemPrompt": "historian",
                "temperature": 0.1,
                "maxTokens": 1000,
            },
        )
        resolutions = []

        def responder(method, request):
            if method == "turn.observe":
                return {
                    "protocolVersion": 1,
                    "observationId": request["observationId"],
                    "sessionId": "session-callback",
                    "accepted": True,
                    "revision": 1,
                    "observedAtMs": request["observedAtMs"],
                    "callbacks": [historian],
                }
            if method == "host.callback.resolve":
                resolutions.append(copy.deepcopy(request))
                return {
                    "protocolVersion": 1,
                    "resolutionId": request["resolutionId"],
                    "callbackId": request["callbackId"],
                    "sessionId": request["sessionId"],
                    "accepted": True,
                    "status": "completed",
                    "revision": 2,
                }
            self.fail(f"unexpected runtime method {method}")

        llm = FakeLlm(text=json.dumps(parsed), parsed=parsed)
        engine = MagicContextEngine(runtime=FakeRuntime(responder), llm=llm)
        engine.session_id = "session-callback"
        engine._observe_turn(
            adapter.observe_request(
                [{"role": "user", "content": "work"}],
                observation_id="turn-callback",
                session_id="session-callback",
                observed_at_ms=int(time.time() * 1000),
            )
        )

        self.assertEqual(llm.calls[0][0], "structured")
        self.assertEqual(
            llm.calls[0][1]["task"], "magic_context_historian"
        )
        self.assertTrue(llm.calls[0][1]["json_mode"])
        self.assertEqual(resolutions[0]["outcome"]["parsed"], parsed)

    def test_elapsed_callback_deadline_reports_timeout_without_calling_llm(self):
        expired = callback(
            "dreamer",
            {
                "mode": "structured",
                "instructions": "curate",
                "input": [{"type": "text", "text": "memory"}],
                "jsonSchema": {"type": "object"},
                "schemaName": "dreamer_output",
            },
            deadline=0,
        )
        outcomes = []

        def responder(method, request):
            self.assertEqual(method, "host.callback.resolve")
            outcomes.append(request["outcome"])
            return {
                "protocolVersion": 1,
                "resolutionId": request["resolutionId"],
                "callbackId": request["callbackId"],
                "sessionId": request["sessionId"],
                "accepted": True,
                "status": "retry_scheduled",
                "revision": 3,
            }

        llm = FakeLlm()
        engine = MagicContextEngine(runtime=FakeRuntime(responder), llm=llm)
        engine._dispatch_runtime_callbacks(
            {"sessionId": "session-callback", "callbacks": [expired]}
        )

        self.assertEqual(llm.calls, [])
        self.assertEqual(outcomes[0]["status"], "timed_out")
        self.assertEqual(engine.get_status()["auxiliary_callback_timeouts"], 1)

    @unittest.skipUnless(shutil.which("node") and RUNTIME_CLI.exists(), "built runtime required")
    def test_real_runtime_command_round_trips_compose_and_observe(self):
        node = shutil.which("node")
        assert node
        with tempfile.TemporaryDirectory(prefix="magic-context-runtime-") as state_dir:
            bridge = module.RuntimeBridge(
                (node, str(RUNTIME_CLI), "--state-dir", state_dir),
                timeout_seconds=5.0,
            )
            engine = MagicContextEngine(runtime=bridge, context_length=4000)
            engine.on_session_start("session-real")
            messages = [{"role": "user", "content": "hello runtime"}]

            selected = engine.select_context(messages, budget_tokens=4000)
            self.assertRegex(selected[0]["content"], r"^§\d+§ hello runtime$")
            self.assertEqual(messages[0]["content"], "hello runtime")

            tool_messages = [
                {"role": "user", "content": "read a file"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-real",
                            "type": "function",
                            "function": {"name": "read", "arguments": "{}"},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call-real", "content": "done"},
            ]
            selected_tools = engine.select_context(tool_messages, budget_tokens=4000)
            self.assertRegex(selected_tools[0]["content"], r"^§\d+§ read a file$")
            self.assertEqual(
                selected_tools[1]["tool_calls"], tool_messages[1]["tool_calls"]
            )
            self.assertRegex(selected_tools[2]["content"], r"^§\d+§ done$")
            self.assertEqual(tool_messages[2]["content"], "done")

            payload = adapter.observe_request(
                messages,
                observation_id="turn-real",
                session_id="session-real",
                observed_at_ms=1000,
                usage={"input_tokens": 20, "output_tokens": 4},
                context_limit_tokens=4000,
            )
            first = bridge.call("turn.observe", payload)
            duplicate = bridge.call("turn.observe", payload)
            self.assertTrue(first["accepted"])
            self.assertFalse(duplicate["accepted"])
            self.assertEqual(first["revision"], duplicate["revision"])

    @unittest.skipUnless(shutil.which("node") and RUNTIME_CLI.exists(), "built runtime required")
    def test_real_runtime_session_executes_historian_and_dreamer_callbacks(self):
        node = shutil.which("node")
        assert node

        class RoutingLlm:
            def __init__(self):
                self.tasks = []

            def complete_structured(self, **kwargs):
                task = kwargs["task"]
                self.tasks.append(task)
                if task == "magic_context_historian":
                    parsed = {
                        "compartments": [
                            {
                                "startOrdinal": 1,
                                "endOrdinal": 8,
                                "title": "Hermes migration",
                                "episodeType": "implementation",
                                "importance": 90,
                                "p1": "The complete migration episode.",
                                "p2": "Hermes executes callbacks while runtime validates them.",
                                "p3": "Runtime validates Hermes callbacks.",
                                "p4": "Reverse RPC.",
                            }
                        ],
                        "memoryCandidates": [
                            {
                                "category": "ARCHITECTURE",
                                "content": "Runtime owns auxiliary validation and persistence.",
                                "importance": 90,
                            }
                        ],
                    }
                else:
                    parsed = {
                        "memoryCandidates": [],
                        "archiveIds": [],
                        "summary": "No memory changes required.",
                    }
                return types.SimpleNamespace(
                    text=json.dumps(parsed),
                    parsed=parsed,
                    provider="fake-provider",
                    model="fake-model",
                    usage=types.SimpleNamespace(
                        input_tokens=20,
                        output_tokens=10,
                        cache_read_tokens=0,
                        cache_write_tokens=0,
                    ),
                )

        policy = {
            "historianEnabled": True,
            "historianThresholdPercentage": 0,
            "historianMinMessages": 4,
            "historianProtectedTailMessages": 2,
            "historianTimeoutMs": 10_000,
            "dreamerEnabled": True,
            "dreamerIntervalMs": 0,
            "dreamerTimeoutMs": 10_000,
            "sidekickEnabled": False,
            "sidekickTimeoutMs": 10_000,
            "maxAttempts": 2,
        }
        with tempfile.TemporaryDirectory(prefix="magic-context-aux-runtime-") as state_dir:
            bridge = module.RuntimeBridge(
                (node, str(RUNTIME_CLI), "--state-dir", state_dir),
                timeout_seconds=5.0,
            )
            llm = RoutingLlm()
            engine = MagicContextEngine(
                runtime=bridge,
                llm=llm,
                context_length=1000,
                auxiliary_policy=policy,
            )
            engine.on_session_start("session-aux-real", project_id="project-aux")
            messages = [
                {
                    "role": "user" if index % 2 == 0 else "assistant",
                    "content": f"migration turn {index + 1}",
                }
                for index in range(10)
            ]
            engine._observe_turn(
                adapter.observe_request(
                    messages,
                    observation_id="turn-aux-real",
                    session_id="session-aux-real",
                    observed_at_ms=int(time.time() * 1000),
                    usage={"input_tokens": 800, "output_tokens": 20},
                    context_limit_tokens=1000,
                    project_id="project-aux",
                )
            )

            self.assertEqual(
                llm.tasks,
                ["magic_context_historian", "magic_context_dreamer"],
            )
            selected = engine.select_context(messages, budget_tokens=1000)
            self.assertTrue(
                any("<session-history>" in str(message.get("content")) for message in selected)
            )
            self.assertLess(len(selected), len(messages))
            self.assertEqual(engine.get_status()["auxiliary_callbacks_completed"], 2)
            engine.on_session_end("session-aux-real", messages)

    def test_invalid_runtime_plan_falls_back_without_escaping_to_hermes(self):
        def responder(_method, request):
            return {
                "protocolVersion": 1,
                "requestId": request["requestId"],
                "decision": "block",
                "retain": {"messageIds": []},
                "mutations": [],
                "injections": [],
                "accounting": {
                    "estimatedInputTokens": 0,
                    "hardLimitTokens": 1000,
                    "cacheDecision": "hit_safe",
                },
            }

        engine = MagicContextEngine(runtime=FakeRuntime(responder), context_length=1000)
        messages = [{"role": "user", "content": "still served safely"}]
        self.assertEqual(engine.select_context(messages, budget_tokens=1000), messages)
        self.assertEqual(engine.get_status()["runtime_failures"], 1)


if __name__ == "__main__":
    unittest.main()
