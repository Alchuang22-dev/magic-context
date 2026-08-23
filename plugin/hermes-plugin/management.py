"""Install, diagnose, and migrate the standalone Magic Context Hermes plugin."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

try:
    from .generated_protocol import (
        PROTOCOL_IDL_SHA256,
        PROTOCOL_VERSION,
        validate_runtime_call,
        validate_runtime_result,
    )
except ImportError:  # Direct execution before the plugin is installed.
    from generated_protocol import (  # type: ignore[no-redef]
        PROTOCOL_IDL_SHA256,
        PROTOCOL_VERSION,
        validate_runtime_call,
        validate_runtime_result,
    )

PLUGIN_ROOT = Path(__file__).resolve().parent
VALID_MEMORY_CATEGORIES = {
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
}


@dataclass(frozen=True)
class ManagementCheck:
    name: str
    ok: bool
    detail: str


@dataclass
class ManagementReport:
    operation: str
    ok: bool = True
    checks: list[ManagementCheck] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def add_check(self, name: str, ok: bool, detail: str) -> None:
        self.checks.append(ManagementCheck(name, ok, detail))
        self.ok = self.ok and ok

    def format_text(self) -> str:
        lines = [f"Magic Context {self.operation}: {'OK' if self.ok else 'FAILED'}"]
        for check in self.checks:
            lines.append(f"  {'OK' if check.ok else 'ERROR'} {check.name}: {check.detail}")
        lines.extend(f"  changed: {item}" for item in self.changed)
        lines.extend(f"  skipped: {item}" for item in self.skipped)
        return "\n".join(lines)

    def format_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


def default_runtime_state_directory() -> Path:
    configured = os.environ.get("MAGIC_CONTEXT_RUNTIME_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    state_root = os.environ.get("XDG_STATE_HOME", "").strip()
    if state_root:
        return Path(state_root).expanduser() / "magic-context/runtime-v1"
    return Path.home() / ".local/state/magic-context/runtime-v1"


def packaged_runtime_path(plugin_root: Path = PLUGIN_ROOT) -> Path | None:
    names = (
        ("magic-context-runtime.exe",)
        if os.name == "nt"
        else ("magic-context-runtime",)
    )
    for name in names:
        candidate = plugin_root / "bin" / name
        if candidate.is_file():
            return candidate
    return None


def resolve_runtime_command(
    explicit: str | None = None, plugin_root: Path = PLUGIN_ROOT
) -> tuple[str, ...]:
    raw = (explicit or os.environ.get("MAGIC_CONTEXT_RUNTIME_COMMAND", "")).strip()
    if raw:
        return tuple(shlex.split(raw))
    packaged = packaged_runtime_path(plugin_root)
    return (str(packaged),) if packaged else ()


def _nearest_existing(path: Path) -> Path:
    candidate = path.expanduser().resolve()
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


def _protocol_manifest(plugin_root: Path) -> dict[str, Any] | None:
    candidates = [
        plugin_root / "protocol-manifest.json",
        plugin_root.parent / "protocol/generated/manifest.json",
    ]
    for candidate in candidates:
        try:
            value = json.loads(candidate.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            return value
    return None


def _protocol_schema(plugin_root: Path) -> Path | None:
    candidates = (
        plugin_root / "magic-context.schema.json",
        plugin_root.parent / "protocol/schema/magic-context.schema.json",
    )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def doctor(
    *,
    plugin_root: Path = PLUGIN_ROOT,
    runtime_command: str | None = None,
    state_directory: Path | None = None,
    include_hermes_doctor: bool = True,
) -> ManagementReport:
    report = ManagementReport("doctor")
    manifest = _protocol_manifest(plugin_root)
    schema = _protocol_schema(plugin_root)
    try:
        schema_sha256 = hashlib.sha256(schema.read_bytes()).hexdigest() if schema else ""
    except OSError:
        schema_sha256 = ""
    manifest_ok = bool(
        manifest
        and manifest.get("protocolVersion") == PROTOCOL_VERSION
        and manifest.get("idlSha256") == PROTOCOL_IDL_SHA256
        and manifest.get("schemaSha256") == schema_sha256
    )
    report.add_check(
        "protocol",
        manifest_ok,
        f"v{PROTOCOL_VERSION} / {PROTOCOL_IDL_SHA256[:12]}"
        if manifest_ok
        else "generated bindings do not match protocol manifest",
    )
    report.add_check(
        "manifest",
        (plugin_root / "plugin.yaml").is_file(),
        str(plugin_root / "plugin.yaml"),
    )
    command = resolve_runtime_command(runtime_command, plugin_root)
    report.add_check(
        "runtime-discovery",
        bool(command),
        shlex.join(command) if command else "no packaged binary or runtime command",
    )
    packaged = packaged_runtime_path(plugin_root)
    if packaged is not None:
        try:
            runtime_manifest = json.loads(
                (plugin_root / "runtime-manifest.json").read_text(encoding="utf8")
            )
            binary_sha256 = hashlib.sha256(packaged.read_bytes()).hexdigest()
            runtime_integrity = bool(
                isinstance(runtime_manifest, dict)
                and runtime_manifest.get("protocolVersion") == PROTOCOL_VERSION
                and runtime_manifest.get("idlSha256") == PROTOCOL_IDL_SHA256
                and runtime_manifest.get("schemaSha256") == schema_sha256
                and runtime_manifest.get("binary") == packaged.name
                and runtime_manifest.get("binarySha256") == binary_sha256
            )
        except (OSError, json.JSONDecodeError):
            runtime_integrity = False
        report.add_check(
            "runtime-integrity",
            runtime_integrity,
            "binary checksum and protocol identity match"
            if runtime_integrity
            else "runtime manifest or binary checksum does not match",
        )
    if command:
        smoke_call = {
            "method": "maintenance.poll",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "pollId": "doctor-poll",
                "host": "hermes-doctor",
                "sessionId": "doctor-session",
                "polledAtMs": 0,
            },
        }
        if not validate_runtime_call(smoke_call):
            report.add_check("runtime-smoke", False, "generated smoke call is invalid")
        else:
            try:
                completed = subprocess.run(
                    [*command, "--memory"],
                    input=json.dumps(smoke_call, separators=(",", ":")) + "\n",
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                output = completed.stdout.strip().splitlines()
                envelope = json.loads(output[-1]) if output else {}
                result = envelope.get("result") if isinstance(envelope, dict) else None
                valid = (
                    completed.returncode == 0
                    and isinstance(result, dict)
                    and validate_runtime_result("maintenance.poll", result)
                )
                detail = (
                    "maintenance.poll round-trip passed"
                    if valid
                    else (completed.stderr.strip() or "invalid runtime response")[:300]
                )
                report.add_check("runtime-smoke", valid, detail)
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
                report.add_check("runtime-smoke", False, str(exc))
    state = state_directory or default_runtime_state_directory()
    writable_parent = _nearest_existing(state)
    report.add_check(
        "state-directory",
        writable_parent.is_dir() and os.access(writable_parent, os.W_OK),
        f"{state} (nearest existing: {writable_parent})",
    )
    if include_hermes_doctor:
        try:
            from hermes_cli.plugin_dev import doctor_plugin

            hermes_report = doctor_plugin(plugin_root)
            report.add_check(
                "hermes-plugin-doctor",
                bool(hermes_report.ok),
                hermes_report.format_text().replace("\n", "; "),
            )
        except Exception as exc:  # Hermes may not be importable in source-only tests.
            report.add_check("hermes-plugin-doctor", False, str(exc))
    return report


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as handle:
            json.dump(value, handle, separators=(",", ":"), ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _legacy_memory(row: sqlite3.Row) -> dict[str, Any] | None:
    content = str(row["content"] or "").strip()
    category = str(row["category"] or "")
    project_key = str(row["project_path"] or "")
    if not content or not project_key or category not in VALID_MEMORY_CATEGORIES:
        return None
    now = int(row["updated_at"] or row["created_at"] or row["first_seen_at"] or 0)
    normalized_hash = str(row["normalized_hash"] or "")
    if not normalized_hash:
        normalized = " ".join(content.lower().split())
        normalized_hash = hashlib.md5(normalized.encode("utf8")).hexdigest()
    source_type = str(row["source_type"] or "historian")
    if source_type not in {"historian", "agent", "dreamer", "tool"}:
        source_type = "historian"
    status = str(row["status"] or "active")
    if status not in {"active", "permanent", "archived"}:
        status = "active"
    verification = str(row["verification_status"] or "unverified")
    if verification not in {"unverified", "verified", "stale", "flagged"}:
        verification = "unverified"
    scope = str(row["scope"] or "project")
    if scope not in {"project", "ecosystem", "universe"}:
        scope = "project"
    memory = {
        "id": int(row["id"]),
        "projectKey": project_key,
        "category": category,
        "content": content,
        "normalizedHash": normalized_hash,
        "importance": float(row["importance"] if row["importance"] is not None else 50),
        "scope": scope,
        "shareable": bool(row["shareable"] or False),
        "sourceType": source_type,
        "seenCount": int(row["seen_count"] or 1),
        "retrievalCount": int(row["retrieval_count"] or 0),
        "firstSeenAtMs": int(row["first_seen_at"] or now),
        "createdAtMs": int(row["created_at"] or now),
        "updatedAtMs": now,
        "lastSeenAtMs": int(row["last_seen_at"] or now),
        "status": status,
        "verificationStatus": verification,
        "mergedFrom": [int(item) for item in _json_list(row["merged_from"]) if isinstance(item, int)],
        "sourceObservationIds": [],
    }
    optional = {
        "sourceSessionId": row["source_session_id"],
        "lastRetrievedAtMs": row["last_retrieved_at"],
        "expiresAtMs": row["expires_at"],
        "verifiedAtMs": row["verified_at"],
        "supersededByMemoryId": row["superseded_by_memory_id"],
        "metadata": _json_object(row["metadata_json"]),
    }
    memory.update({key: value for key, value in optional.items() if value is not None})
    return memory


def migrate_legacy_sqlite(
    source: Path,
    destination: Path,
    *,
    dry_run: bool = False,
    force: bool = False,
) -> ManagementReport:
    report = ManagementReport("migrate")
    if not source.is_file():
        report.add_check("source", False, f"not a file: {source}")
        return report
    try:
        connection = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(memories)")
        }
        required = {"id", "project_path", "category", "content"}
        if not required.issubset(columns):
            report.add_check("source-schema", False, "memories table is missing")
            connection.close()
            return report
        selectable = [
            "id",
            "project_path",
            "category",
            "content",
            "normalized_hash",
            "importance",
            "source_session_id",
            "source_type",
            "seen_count",
            "retrieval_count",
            "first_seen_at",
            "created_at",
            "updated_at",
            "last_seen_at",
            "last_retrieved_at",
            "status",
            "expires_at",
            "verification_status",
            "verified_at",
            "superseded_by_memory_id",
            "merged_from",
            "metadata_json",
            "scope",
            "shareable",
        ]
        select_sql = ", ".join(
            name if name in columns else f"NULL AS {name}" for name in selectable
        )
        rows = connection.execute(f"SELECT {select_sql} FROM memories ORDER BY id").fetchall()
        connection.close()
    except sqlite3.Error as exc:
        report.add_check("source-schema", False, str(exc))
        return report
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        memory = _legacy_memory(row)
        if memory is None:
            report.skipped.append(f"legacy memory row {row['id']} is not portable")
            continue
        grouped.setdefault(memory["projectKey"], []).append(memory)
    report.add_check("source-schema", True, f"{len(rows)} memory rows inspected")
    memory_directory = destination / "memories"
    for project_key, memories in grouped.items():
        filename = hashlib.sha256(project_key.encode("utf8")).hexdigest() + ".json"
        target = memory_directory / filename
        if target.exists() and not force:
            report.ok = False
            report.skipped.append(f"{target} exists; use --force")
            continue
        collection = {
            "schemaVersion": 1,
            "projectKey": project_key,
            "revision": 1,
            "nextId": max(memory["id"] for memory in memories) + 1,
            "memories": memories,
        }
        if not dry_run:
            _atomic_json(target, collection)
        report.changed.append(
            f"{'would write' if dry_run else 'wrote'} {target} ({len(memories)} memories)"
        )
    report.skipped.append(
        "session tags/compartments are host-transcript identities and are intentionally not imported"
    )
    return report


def migrate_json_directory(
    source: Path,
    destination: Path,
    *,
    dry_run: bool = False,
    force: bool = False,
) -> ManagementReport:
    report = ManagementReport("migrate")
    if not source.is_dir():
        report.add_check("source", False, f"not a directory: {source}")
        return report
    files = [path for path in source.rglob("*.json") if path.is_file()]
    report.add_check("source-schema", bool(files), f"{len(files)} JSON documents")
    for path in files:
        relative = path.relative_to(source)
        target = destination / relative
        try:
            value = json.loads(path.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            report.ok = False
            report.skipped.append(f"invalid JSON: {path}")
            continue
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            report.ok = False
            report.skipped.append(f"unsupported schema: {path}")
            continue
        if target.exists() and not force:
            report.ok = False
            report.skipped.append(f"{target} exists; use --force")
            continue
        if not dry_run:
            _atomic_json(target, value)
        report.changed.append(f"{'would copy' if dry_run else 'copied'} {relative}")
    return report


def migrate(
    source: Path,
    destination: Path,
    *,
    dry_run: bool = False,
    force: bool = False,
) -> ManagementReport:
    return (
        migrate_json_directory(source, destination, dry_run=dry_run, force=force)
        if source.is_dir()
        else migrate_legacy_sqlite(source, destination, dry_run=dry_run, force=force)
    )


def install_bundle(
    source: Path,
    hermes_home: Path,
    *,
    runtime: Path | None = None,
    dry_run: bool = False,
    force: bool = False,
) -> ManagementReport:
    report = ManagementReport("install")
    source = source.resolve()
    if not (source / "plugin.yaml").is_file() or not (source / "__init__.py").is_file():
        report.add_check("source", False, f"not a Hermes plugin bundle: {source}")
        return report
    target = hermes_home.expanduser() / "plugins/magic-context"
    if target.exists() and not force:
        report.add_check("target", False, f"{target} exists; use --force")
        return report
    report.add_check("source", True, str(source))
    if dry_run:
        report.changed.append(f"would install {target}")
        return report
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = Path(tempfile.mkdtemp(prefix=".magic-context-", dir=target.parent))
    backup = target.with_name(".magic-context.previous")
    try:
        shutil.copytree(
            source,
            staging,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests"),
        )
        protocol_manifest = _protocol_manifest(source)
        if protocol_manifest is None:
            raise ValueError("protocol manifest was not found beside the plugin bundle")
        _atomic_json(staging / "protocol-manifest.json", protocol_manifest)
        schema_candidates = (
            source / "magic-context.schema.json",
            source.parent / "protocol/schema/magic-context.schema.json",
        )
        for schema in schema_candidates:
            if schema.is_file():
                shutil.copy2(schema, staging / "magic-context.schema.json")
                break
        if runtime is not None:
            bin_directory = staging / "bin"
            bin_directory.mkdir(parents=True, exist_ok=True)
            runtime_name = "magic-context-runtime.exe" if os.name == "nt" else "magic-context-runtime"
            shutil.copy2(runtime, bin_directory / runtime_name)
            os.chmod(bin_directory / runtime_name, 0o755)
            runtime_manifest = runtime.parent / "runtime-manifest.json"
            if runtime_manifest.is_file():
                shutil.copy2(runtime_manifest, staging / "runtime-manifest.json")
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            os.replace(target, backup)
        os.replace(staging, target)
        if backup.exists():
            shutil.rmtree(backup)
        report.changed.append(f"installed {target}")
    except Exception:
        if target.exists():
            shutil.rmtree(target)
        if backup.exists():
            os.replace(backup, target)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return report


def _emit(report: ManagementReport, as_json: bool) -> None:
    print(report.format_json() if as_json else report.format_text())
    if not report.ok:
        raise SystemExit(1)


def configure_cli(parser: argparse.ArgumentParser) -> None:
    subcommands = parser.add_subparsers(dest="magic_context_action", required=True)
    install_parser = subcommands.add_parser("install", help="Install a local release bundle")
    install_parser.add_argument("source", nargs="?", default=str(PLUGIN_ROOT))
    install_parser.add_argument("--runtime")
    install_parser.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME", "~/.hermes"))
    install_parser.add_argument("--force", action="store_true")
    install_parser.add_argument("--dry-run", action="store_true")
    install_parser.add_argument("--json", action="store_true")

    doctor_parser = subcommands.add_parser("doctor", help="Validate plugin, protocol, runtime, and storage")
    doctor_parser.add_argument("--runtime-command")
    doctor_parser.add_argument("--state-dir", default=str(default_runtime_state_directory()))
    doctor_parser.add_argument("--json", action="store_true")

    migrate_parser = subcommands.add_parser("migrate", help="Import v1 JSON state or legacy SQLite memories")
    migrate_parser.add_argument("source")
    migrate_parser.add_argument("--state-dir", default=str(default_runtime_state_directory()))
    migrate_parser.add_argument("--force", action="store_true")
    migrate_parser.add_argument("--dry-run", action="store_true")
    migrate_parser.add_argument("--json", action="store_true")


def handle_cli(args: argparse.Namespace) -> None:
    action = args.magic_context_action
    if action == "install":
        report = install_bundle(
            Path(args.source),
            Path(args.hermes_home),
            runtime=Path(args.runtime) if args.runtime else None,
            dry_run=args.dry_run,
            force=args.force,
        )
    elif action == "doctor":
        report = doctor(
            runtime_command=args.runtime_command,
            state_directory=Path(args.state_dir),
        )
    elif action == "migrate":
        report = migrate(
            Path(args.source),
            Path(args.state_dir),
            dry_run=args.dry_run,
            force=args.force,
        )
    else:  # pragma: no cover - argparse enforces this.
        raise SystemExit(f"unknown action {action}")
    _emit(report, args.json)


def main(argv: Iterable[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="magic-context-hermes")
    configure_cli(parser)
    handle_cli(parser.parse_args(list(argv) if argv is not None else None))


if __name__ == "__main__":
    main()
