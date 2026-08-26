# Releasing

1. Confirm CI passes on `main`.
2. Update `CHANGELOG.md` and the version in `Cargo.toml`.
3. Run `npm ci`, `npm run check:traces`, and `cargo test --locked --all-targets`.
4. Run `cargo package --locked` and test the packaged crate.
5. Run `cargo publish --dry-run --locked`.
6. Publish only after the crates.io owner and repository settings are configured.
7. Tag the published commit as `v<version>` and create release notes from the changelog.

Publishing is deliberately manual until crates.io trusted publishing is configured for this repository.
