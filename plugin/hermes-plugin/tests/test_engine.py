from __future__ import annotations

import copy
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
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


class MagicContextEngineTests(unittest.TestCase):
    def test_register_declares_auxiliary_tasks_and_context_engine(self):
        class FakeContext:
            def __init__(self):
                self.llm = object()
                self.tasks = []
                self.engine = None

            def register_auxiliary_task(self, **kwargs):
                self.tasks.append(kwargs)

            def register_context_engine(self, engine):
                self.engine = engine

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
