# Binding conformance corpus

Every runtime binding consumes the same schema-v2 artifact and must execute the
cases in `cases/` against its real implementation boundary.

Each case contains:

1. `artifact.json` — compiler output accepted by every binding.
2. `expected.json` — externally observable actions, result state, and evaluated
   obligation count.

`artifact.schema.json` defines the shared wire format. Binding-specific types
may be stricter, but cannot reinterpret these fields. Root `npm test` checks
that the golden artifacts still match the generated Rust examples.

