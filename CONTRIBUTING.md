# Contributing

1. Install Rust 1.85 or newer (with `rustfmt` and `clippy`) and Node.js 22 or newer.
2. Run `npm ci` to install the pinned Quint CLI.
3. Run `npm test` and `cargo test --locked --manifest-path bindings/rust/Cargo.toml --all-targets`.
4. Run `cargo fmt --manifest-path bindings/rust/Cargo.toml -- --check` and `cargo clippy --locked --manifest-path bindings/rust/Cargo.toml --all-targets -- -D warnings`.

## Generated files

`npm run generate` rewrites every file this repository derives from a Quint
model: the example adapters, their artifacts, and the conformance corpus.
`npm test` fails when any of them has drifted.

1. Never edit a file marked `@generated`. Change the model or
   `packages/compiler`, then run `npm run generate`.
2. Commit regenerated files together with the change that produced them.
3. A new compiler capability needs no new configuration surface if the Quint
   AST already holds the fact. See `rules/generate-derived-boilerplate.md`.

Please add a focused regression test for behavior changes.
