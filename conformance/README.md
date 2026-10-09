# Binding conformance corpus

Every runtime binding consumes the same schema-v2 artifact and must execute the
cases in `cases/` against its real implementation boundary.

Each case contains:

1. `artifact.json` — compiler output accepted by every binding.
2. `expected.json` — externally observable actions, result state, and evaluated
   obligation count.

`artifact.schema.json` defines the shared wire format. Binding-specific types
may be stricter, but cannot reinterpret these fields.

1. `npm run generate` rewrites each `artifact.json` from its Quint model, and
   `npm test` fails when one has drifted or violates the schema.
2. The Rust binding executes the corpus in `bindings/rust/corpus/corpus.rs`
   and in the bank example's test, comparing primitive calls, obligation
   count, and final state with `expected.json`.

