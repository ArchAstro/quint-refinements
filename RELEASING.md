# Releasing

1. Confirm CI passes on `main`.
2. Update `CHANGELOG.md` and the package being released: root `package.json` or `bindings/rust/Cargo.toml`.
3. Run `npm ci`, `npm test`, and `cargo test --locked --manifest-path bindings/rust/Cargo.toml --all-targets`.
4. Run `npm pack --dry-run` for the compiler or `cargo package --locked --manifest-path bindings/rust/Cargo.toml` for Rust.
5. Run the relevant registry dry run.
6. Publish only after the target registry's owners and repository settings are configured.
7. Tag compiler releases as `compiler-v<version>` and Rust releases as `rust-v<version>`.

Publishing is deliberately manual until trusted publishing is configured for each registry.
