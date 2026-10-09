# Quint refinements compiler

This package reads annotated Quint runs through Quint's own parser and
generates a language-neutral conformance artifact plus the adapter for the
selected runtime.

```console
npx quint-refinements new bank-refinement
cd bank-refinement
cargo run
# Edit model.qnt, then:
npx quint-refinements compile
```

In the model, `/// @conformance` above a `run` marks a refinement scenario.
`/// @primitive name = [firstAction, secondAction]` in the module comment gives
one implementation command an ordered sequence of actions. Nothing else is
configured.

The current adapter target is Rust. Additional language bindings live in the
same repository and consume the same generated artifact schema.

The lower-level generator remains available as
`quint-refinements/generate.mjs` for custom capability names or partial
refinement. The shared binding wire contract is exported as
`quint-refinements/artifact.schema.json`.
