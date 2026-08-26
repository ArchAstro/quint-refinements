# Contributing

1. Install Rust 1.85 or newer and Node.js 22 or newer.
2. Run `npm ci` to install the pinned Quint CLI.
3. Run `npm run check:traces` and `cargo test --locked --all-targets`.
4. Run `cargo fmt --all -- --check` and `cargo clippy --locked --all-targets -- -D warnings`.

Generated trace changes must include the Quint model or generator change that produced them. Please add a focused regression test for behavior changes.
