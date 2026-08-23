#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "magic_context_protocol", ROOT / "generated/python/magic_context_protocol.py"
)
assert spec and spec.loader
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)

golden = json.loads((Path(__file__).with_name("golden.json")).read_text())
results = []
for case in golden:
    if case["target"] == "call":
        accepted = protocol.validate_runtime_call(case["value"])
    else:
        accepted = protocol.validate_runtime_result(case.get("method", ""), case["value"])
    results.append({"id": case["id"], "accepted": accepted})
print(json.dumps(results, separators=(",", ":")))
