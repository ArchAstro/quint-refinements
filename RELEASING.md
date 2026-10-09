# Releasing

The compiler (npm) and the Rust runtime (crates.io) release together under one
version. One tag publishes both, in an order that keeps the quick start working:

```text
vX.Y.Z tag ─> verify ─> crates.io ─> npm ─> run the published quick start ─> GitHub release
```

## Cut a release

1. Confirm CI passes on `main`.
2. In a PR, set the version in three places and update `CHANGELOG.md`:
   - `npm version <patch|minor|major> --no-git-tag-version` (`package.json`, `package-lock.json`)
   - `version` in `bindings/rust/Cargo.toml`, then `cargo check --manifest-path bindings/rust/Cargo.toml` to refresh `Cargo.lock`
   - `cargo check --manifest-path examples/rust/bank_account/Cargo.toml` to refresh its lockfile
3. Run `npm test`. It fails if the two versions differ.
4. Merge the PR, update local `main`, and tag that exact commit:

```console
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

`.github/workflows/publish.yml` does the rest. Every job is safe to re-run: a
version that is already published with the same contents is skipped.

## One-time registry setup

A package owner does these once. They need registry login and 2FA, so coding
agents do not run them.

### crates.io

crates.io can only trust a workflow for a crate that already exists, so the
first release uses a token:

1. Create a token at <https://crates.io/settings/tokens> with the
   `publish-new` and `publish-update` scopes.
2. Add it as the repository secret `CARGO_REGISTRY_TOKEN`:
   `gh secret set CARGO_REGISTRY_TOKEN --repo ArchAstro/quint-refinements`
3. Push the first release tag.
4. After it publishes, open the crate's Settings > Trusted Publishing on
   crates.io and add GitHub repository `ArchAstro/quint-refinements` with
   workflow `publish.yml`.
5. Delete the secret (`gh secret delete CARGO_REGISTRY_TOKEN`) and revoke the
   token. Later releases authenticate through OIDC.

### npm

With npm 11.15 or newer, from the repository root:

```console
npm trust github quint-refinements \
  --file publish.yml \
  --repo ArchAstro/quint-refinements \
  --allow-publish
npm trust list quint-refinements
```
