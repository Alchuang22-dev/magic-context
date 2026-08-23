from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
PACKAGE = "magic_context_hermes_management_tests"


def _load_module(name: str, path: Path):
    package = sys.modules.get(PACKAGE)
    if package is None:
        package = types.ModuleType(PACKAGE)
        package.__path__ = [str(PLUGIN_DIR)]
        sys.modules[PACKAGE] = package
    qualified = f"{PACKAGE}.{name}"
    spec = importlib.util.spec_from_file_location(qualified, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[qualified] = module
    spec.loader.exec_module(module)
    return module


_load_module("generated_protocol", PLUGIN_DIR / "generated_protocol.py")
management = _load_module("management", PLUGIN_DIR / "management.py")


class ManagementTests(unittest.TestCase):
    def test_doctor_checks_generated_protocol_and_real_runtime_round_trip(self):
        with tempfile.TemporaryDirectory(prefix="magic-context-doctor-") as directory:
            root = Path(directory)
            runtime = root / "runtime.py"
            runtime.write_text(
                """import json,sys
for line in sys.stdin:
 request=json.loads(line)
 params=request['params']
 print(json.dumps({'result': {'protocolVersion': 1, 'pollId': params['pollId'], 'sessionId': params['sessionId'], 'revision': 0, 'callbacks': []}}))
""",
                encoding="utf8",
            )
            report = management.doctor(
                plugin_root=PLUGIN_DIR,
                runtime_command=f"{sys.executable} {runtime}",
                state_directory=root / "state",
                include_hermes_doctor=False,
            )

            self.assertTrue(report.ok, report.format_text())
            self.assertIn("runtime-smoke", [check.name for check in report.checks])

    def test_migrate_imports_legacy_sqlite_memories_without_session_identity(self):
        with tempfile.TemporaryDirectory(prefix="magic-context-migrate-") as directory:
            root = Path(directory)
            source = root / "context.db"
            database = sqlite3.connect(source)
            database.executescript(
                """
                CREATE TABLE memories (
                  id INTEGER PRIMARY KEY,
                  project_path TEXT NOT NULL,
                  category TEXT NOT NULL,
                  content TEXT NOT NULL,
                  normalized_hash TEXT,
                  importance INTEGER,
                  source_type TEXT,
                  seen_count INTEGER,
                  retrieval_count INTEGER,
                  first_seen_at INTEGER,
                  created_at INTEGER,
                  updated_at INTEGER,
                  last_seen_at INTEGER,
                  status TEXT,
                  verification_status TEXT,
                  scope TEXT,
                  shareable INTEGER
                );
                INSERT INTO memories VALUES (
                  7, 'git:project', 'ARCHITECTURE', 'Runtime owns policy.',
                  'hash', 80, 'historian', 2, 1, 10, 10, 20, 20,
                  'active', 'verified', 'project', 0
                );
                """
            )
            database.commit()
            database.close()

            destination = root / "runtime-v1"
            report = management.migrate(source, destination)

            self.assertTrue(report.ok, report.format_text())
            files = list((destination / "memories").glob("*.json"))
            self.assertEqual(len(files), 1)
            collection = json.loads(files[0].read_text(encoding="utf8"))
            self.assertEqual(collection["projectKey"], "git:project")
            self.assertEqual(collection["memories"][0]["id"], 7)
            self.assertIn("session tags/compartments", " ".join(report.skipped))

    def test_install_dry_run_is_non_destructive(self):
        with tempfile.TemporaryDirectory(prefix="magic-context-install-") as directory:
            home = Path(directory)
            report = management.install_bundle(
                PLUGIN_DIR, home, dry_run=True, force=False
            )
            self.assertTrue(report.ok)
            self.assertFalse((home / "plugins/magic-context").exists())
            self.assertIn("would install", report.changed[0])

    def test_install_source_bundle_includes_generated_protocol_contract(self):
        with tempfile.TemporaryDirectory(prefix="magic-context-install-") as directory:
            home = Path(directory)
            report = management.install_bundle(PLUGIN_DIR, home)
            target = home / "plugins/magic-context"

            self.assertTrue(report.ok, report.format_text())
            manifest = json.loads(
                (target / "protocol-manifest.json").read_text(encoding="utf8")
            )
            self.assertEqual(manifest["protocolVersion"], 1)
            self.assertTrue((target / "magic-context.schema.json").is_file())

    def test_doctor_rejects_a_tampered_packaged_runtime(self):
        with tempfile.TemporaryDirectory(prefix="magic-context-integrity-") as directory:
            root = Path(directory)
            release = root / "release"
            release.mkdir()
            runtime = release / "magic-context-runtime"
            runtime.write_text(
                f"""#!{sys.executable}
import json,sys
for line in sys.stdin:
 request=json.loads(line); params=request['params']
 print(json.dumps({{'result': {{'protocolVersion': 1, 'pollId': params['pollId'], 'sessionId': params['sessionId'], 'revision': 0, 'callbacks': []}}}}))
""",
                encoding="utf8",
            )
            runtime.chmod(0o755)
            protocol_manifest = json.loads(
                (PLUGIN_DIR.parent / "protocol/generated/manifest.json").read_text(
                    encoding="utf8"
                )
            )
            (release / "runtime-manifest.json").write_text(
                json.dumps(
                    {
                        **protocol_manifest,
                        "binary": "magic-context-runtime",
                        "binarySha256": hashlib.sha256(runtime.read_bytes()).hexdigest(),
                    }
                ),
                encoding="utf8",
            )
            home = root / "home"
            install = management.install_bundle(PLUGIN_DIR, home, runtime=runtime)
            target = home / "plugins/magic-context"

            self.assertTrue(install.ok, install.format_text())
            healthy = management.doctor(
                plugin_root=target,
                state_directory=root / "state",
                include_hermes_doctor=False,
            )
            self.assertTrue(healthy.ok, healthy.format_text())

            packaged = target / "bin/magic-context-runtime"
            packaged.write_text("tampered", encoding="utf8")
            tampered = management.doctor(
                plugin_root=target,
                state_directory=root / "state",
                include_hermes_doctor=False,
            )
            integrity = next(
                check for check in tampered.checks if check.name == "runtime-integrity"
            )
            self.assertFalse(integrity.ok)
            self.assertFalse(tampered.ok)


if __name__ == "__main__":
    unittest.main()
