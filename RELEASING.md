# Releasing

## One-time npm trusted publisher setup

The package owner runs this from the repository root with npm 11.15 or newer:

```console
npm trust github quint-refinements \
  --file publish.yml \
  --repo ArchAstro/quint-refinements \
  --allow-publish
```

Confirm the resulting publisher:

```console
npm trust list quint-refinements
```

This registry operation requires npm authentication and 2FA. Coding agents do
not run it.

## Compiler package

1. Confirm CI passes on `main`.
2. Update `CHANGELOG.md`, then bump `package.json` and `package-lock.json` with `npm version <patch|minor|major> --no-git-tag-version` in a PR.
3. Run `npm ci`, `npm test`, `npm audit --audit-level=high`, and `npm pack --dry-run`.
4. Merge the release PR, update local `main`, and tag that exact commit as `compiler-v<version>`.
5. Push the tag. `.github/workflows/publish.yml` verifies the tag and package, publishes through npm OIDC, and creates the GitHub release.

```console
git tag -a compiler-v0.1.1 -m "compiler-v0.1.1"
git push origin compiler-v0.1.1
```

## Rust crate

1. Confirm CI passes on `main`.
2. Update `CHANGELOG.md` and `bindings/rust/Cargo.toml` in a PR.
3. Run `cargo test --locked --manifest-path bindings/rust/Cargo.toml --all-targets`.
4. Run `cargo package --locked --manifest-path bindings/rust/Cargo.toml`.
5. Publish manually, then tag the release as `rust-v<version>`.
