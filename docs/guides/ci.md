# Guide: keep generated files honest in CI

`quint-refinements.json` and `src/generated_refinement.rs` are checked in. That keeps `cargo build` free of Node.js, and makes every model change visible in review. The cost is that they can go stale. One command prevents it.

## 1. The check

```console
npx quint-refinements compile --check
```

It regenerates both files in memory and compares them with what is on disk. Nothing is written. If the model changed and the files did not:

```text
quint-refinements.json drifted; run quint-refinements compile
```

A project created by `new` has this as `npm run check`, with the compiler version pinned in `package.json`.

## 2. A GitHub Actions job

```yaml
name: Refinement

on:
  pull_request:
  push:
    branches: [main]

jobs:
  refine:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt
      - run: npm ci
      - name: Generated files match the model
        run: npm run check
      - name: The implementation refines the model
        run: cargo test
```

Two steps do the work:

1. `npm run check` fails when someone edits the model without regenerating, or edits a generated file by hand.
2. `cargo test` runs every `@conformance` scenario against the implementation.

`rustfmt` is required because the compiler formats the Rust it generates.

## 3. The rules that keep this working

1. Never edit a file that starts with `// @generated`. Change the model and run `compile`.
2. Commit the regenerated files in the same change as the model edit.
3. `src/main.rs` (or wherever your implementation lives) is yours. `compile` creates it once and never overwrites it.

## 4. Generating into an existing crate

If the model lives beside a crate that already has its own layout, say where the two files go:

```console
npx quint-refinements compile spec/model.qnt \
  --artifact spec/scenarios.json \
  --rust src/refinement/generated.rs
```

Use the same flags with `--check`. With custom paths the compiler does not scaffold `src/main.rs`; add `mod generated;` where you want the module and implement its `Implementation` trait for your type.

When several modules in one file declare scenarios, pick one with `--module <name>`.
