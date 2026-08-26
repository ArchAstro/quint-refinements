## Problem and author intent

<!-- What failed or is missing, the intended outcome, and the approach. -->

## What changed

## Verification

- [ ] `npm run check:traces`
- [ ] `npm run test:compiler`
- [ ] `cargo test --locked --manifest-path bindings/rust/Cargo.toml --all-targets`
- [ ] `cargo fmt --manifest-path bindings/rust/Cargo.toml -- --check`
- [ ] `cargo clippy --locked --manifest-path bindings/rust/Cargo.toml --all-targets -- -D warnings`

## Risk and compatibility

## Follow-ups
