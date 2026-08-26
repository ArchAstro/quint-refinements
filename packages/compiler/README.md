# Quint refinements compiler

This package parses annotated Quint runs and generates a language-neutral
conformance artifact plus the selected runtime adapter.

```console
npx quint-refinements new bank-refinement
cd bank-refinement
# Edit model.qnt.
npx quint-refinements compile model.qnt
```

The current adapter target is Rust. Additional language bindings live in the
same repository and consume the same generated artifact schema.

The lower-level generator remains available as
`quint-refinements/generate.mjs` for custom ownership mappings.
The shared binding wire contract is exported as
`quint-refinements/artifact.schema.json`.
