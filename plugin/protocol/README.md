# Magic Context protocol

`idl/magic-context.json` is the only editable wire-contract source. The
generator derives the Draft 2020-12 JSON Schema plus TypeScript, Python, and
Rust bindings. Generated files are committed so each host can consume the
protocol without running a language-specific generator at install time.

```bash
bun run --cwd plugin/protocol generate
bun run --cwd plugin/protocol check:generated
bun run --cwd plugin/protocol conformance
```

CI rejects stale generated output. Protocol changes therefore begin in the
IDL, regenerate every Adapter binding in one operation, and pass the same
positive and negative golden cases in all three languages.

Published package exports include:

- `@cortexkit/magic-context-protocol` for generated TypeScript types and
  validators;
- `@cortexkit/magic-context-protocol/schema` and `/idl` for the machine-readable
  contract;
- `/python` and `/rust` for dependency-light generated bindings.

`generated/manifest.json` binds the protocol version and IDL/Schema SHA-256
hashes. The runtime binary and Hermes release bundle repeat that identity so a
doctor check can reject a mixed-version installation before an agent turn.
