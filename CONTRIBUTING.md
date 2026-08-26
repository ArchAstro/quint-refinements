# Contributing

1. Install Rust 1.85 or newer and Node.js 22 or newer.
2. Run `npm ci` to install the pinned Quint CLI.
3. Run `npm test` and `cargo test --locked --manifest-path bindings/rust/Cargo.toml --all-targets`.
4. Run `cargo fmt --manifest-path bindings/rust/Cargo.toml -- --check` and `cargo clippy --locked --manifest-path bindings/rust/Cargo.toml --all-targets -- -D warnings`.

Generated trace changes must include the Quint model or generator change that produced them. Please add a focused regression test for behavior changes.
