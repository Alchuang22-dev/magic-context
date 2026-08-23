"""Transport boundary between the Hermes adapter and Magic Context runtime."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from typing import Any


class RuntimeBridgeError(RuntimeError):
    """The external runtime failed or returned an invalid response."""


@dataclass(frozen=True)
class RuntimeBridge:
    """One-shot JSON bridge used while the long-running runtime is extracted.

    The command is deliberately explicit. The adapter never invokes a package
    manager or downloads code at runtime.
    """

    command: tuple[str, ...] = ()
    timeout_seconds: float = 8.0

    @classmethod
    def from_environment(cls) -> "RuntimeBridge":
        raw = os.environ.get("MAGIC_CONTEXT_RUNTIME_COMMAND", "").strip()
        timeout_raw = os.environ.get("MAGIC_CONTEXT_RUNTIME_TIMEOUT_SECONDS", "8").strip()
        try:
            timeout = max(0.1, float(timeout_raw))
        except ValueError:
            timeout = 8.0
        return cls(tuple(shlex.split(raw)) if raw else (), timeout)

    @property
    def available(self) -> bool:
        return bool(self.command)

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any] | None:
        if not self.command:
            return None
        request = {"method": method, "params": params}
        try:
            completed = subprocess.run(
                self.command,
                input=json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n",
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeBridgeError(f"runtime invocation failed: {exc}") from exc
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeBridgeError(
                f"runtime exited with status {completed.returncode}: {detail[:500]}"
            )
        output = completed.stdout.strip()
        if not output:
            raise RuntimeBridgeError("runtime returned an empty response")
        try:
            response = json.loads(output.splitlines()[-1])
        except json.JSONDecodeError as exc:
            raise RuntimeBridgeError("runtime returned invalid JSON") from exc
        if not isinstance(response, dict):
            raise RuntimeBridgeError("runtime response must be an object")
        if response.get("error") is not None:
            raise RuntimeBridgeError(f"runtime error: {response['error']}")
        result = response.get("result", response)
        if not isinstance(result, dict):
            raise RuntimeBridgeError("runtime result must be an object")
        return result
