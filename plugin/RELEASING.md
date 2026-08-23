# Protocol and runtime release

The release chain has one direction:

```text
protocol/idl/magic-context.json
  -> JSON Schema + TS/Python/Rust bindings + protocol manifest
  -> Core Module -> Runtime Module
  -> platform runtime manifest + Hermes bundle + SHA256SUMS
```

Generated files are committed, but never edited. The editable wire source is
only `protocol/idl/magic-context.json`.

## Release gate

Run the same local gates as CI:

```bash
bun install --frozen-lockfile
bun run plugin:protocol:check
bun run plugin:release:check
bun run plugin:protocol:conformance
bun run plugin:typecheck
bun run plugin:lint
bun run plugin:test
```

The conformance gate evaluates 16 positive/negative cases in generated
TypeScript, Python, and Rust validators and requires one identical result
vector. The test gate also compares OpenCode/Pi/Hermes canonical transcript
semantics and exercises the real stdio runtime from Hermes.

Before tagging, bump the same version in:

- `protocol/package.json`;
- `core-plugin/package.json` and its protocol dependency;
- `runtime/package.json` and its Core dependency;
- `hermes-plugin/plugin.yaml`.

`plugin:release:check` rejects version drift, stale IDL/Schema hashes, mismatched
public dependency versions, and a tag that differs from
`core-plugin-v<version>`.

## Build and inspect one target

```bash
bun run plugin:release:runtime -- --target linux-x64 --output release
node plugin/scripts/smoke-runtime.mjs release/linux-x64
```

Supported release targets:

| Target | Runtime | Hermes archive |
| --- | --- | --- |
| `linux-x64` | `magic-context-runtime` | `.tar.gz` |
| `linux-arm64` | `magic-context-runtime` | `.tar.gz` |
| `darwin-x64` | `magic-context-runtime` | `.tar.gz` |
| `darwin-arm64` | `magic-context-runtime` | `.tar.gz` |
| `windows-x64` | `magic-context-runtime.exe` | `.tar.gz` |

The smoke command recomputes the binary/archive checksums, compares the binary's
embedded protocol identity with `runtime-manifest.json`, and performs a real
`maintenance.poll` round trip. CI uses QEMU for the Linux arm64 execution gate;
the other four artifacts run natively on their matrix runner.

## Publish

Pushing `core-plugin-v<version>` runs `.github/workflows/core-plugin-release.yml`.
It publishes the dependency chain in order:

1. `@cortexkit/magic-context-protocol`;
2. `@cortexkit/magic-context-core-plugin`;
3. `@cortexkit/magic-context-runtime`.

The npm environment must configure trusted publishers for those packages and
this workflow. GitHub Release receives all five Hermes archives, target
manifests, and checksum files. OpenCode/Pi adapter packages remain private until
their published-hook cutover is complete.

CI always runs Hermes source/bundle install, doctor, JSON migration, SQLite
migration unit coverage, and provider-free end-to-end checks. If repository
secrets `MAGIC_CONTEXT_LIVE_API_KEY` and `MAGIC_CONTEXT_LIVE_MODEL` are set, it
also runs the real provider/session test; `MAGIC_CONTEXT_LIVE_BASE_URL` is an
optional override. Credentials are passed only to that step and the test checks
that they were not persisted beneath its temporary Hermes home.
