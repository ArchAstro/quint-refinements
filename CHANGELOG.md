# Changelog

This project follows [Semantic Versioning](https://semver.org/). The compiler
and the Rust runtime share one version.

## 0.2.0

The first release of the Rust runtime on crates.io, and the first where the
whole integration is generated from the model.

### Added

- `quint-refinements new` creates a project that already passes: a counter
  model, its Rust implementation, and the generated adapter.
- A bare `/// @conformance` marks a run as a refinement scenario. Capabilities
  are derived from the run, so action names may use any case.
- `/// @primitive name = [first, second]` in the module comment generates one
  implementation hook that owns an ordered sequence of Quint actions.
- Scenarios may import their model from other `.qnt` files.
- Named constants need no Rust: the generated `fixtures` default takes each
  value from the model through the new `FixtureTable::from_artifact`. Override
  it to bind a constant to a production value.
- Constants may be passed as action arguments, and assertions may combine
  conditions with `all { }`.
- An action with no single `state' = ...` conjunct (`if`/`else`, `any`) is
  held to the exact state Quint reached after it.
- Every generated obligation is checked at runtime.
- Model errors from Quint are reported with file, line and column.
- Step-by-step guides for constants and branching, `@primitive`, and CI, with
  how-it-works and troubleshooting pages. Guide code is quoted from example
  projects that CI compiles and runs.
- `compile` defaults to `model.qnt` and accepts `--artifact` and `--rust` to
  place generated files in an existing crate.
- The generated module exposes `OWNERSHIP`, `RETRIEVE`, `artifact()` and
  `Driver`, which also implements `AsyncPrimitiveDriver`.
- The compiler rejects models the runtime cannot check (state outside one
  record `var state`, malformed annotations) with a message that names the fix.
- One `vX.Y.Z` tag publishes the crate and the npm package, then runs the
  published quick start.

### Changed

- The low-level generator inlines observation helpers only when the app sets
  `inlineObservations`; `compile` sets it. Apps with a closed expression
  vocabulary keep resolving the operators their observations name, as they
  did before the `compile` command existed.

- The two-phase commit example is generated from its annotated model. Its
  hand-written `app-config.mjs` and `generate-traces.mjs` are gone, and its
  primitives are named `two_phase_commit.begin`, `two_phase_commit.abort` and
  `two_phase_commit.commit`.
- `npm run generate` and `npm run check:generated` replace `generate:traces`,
  `check:traces` and `check:bank`.
- Release tags are `vX.Y.Z`; `compiler-v*` and `rust-v*` tags are retired.

### Fixed

- The 0.1.0 starter model could not refine: its state was a bare integer.
- Projects scaffolded by 0.1.0 depended on a crate version that was never
  published.
- The Rust binding now executes the shared conformance corpus, including its
  expected primitive calls and final state.
- Updated `adm-zip`, `fast-uri` and `@grpc/grpc-js` past their published
  advisories.

## 0.1.0

- Extract the refinement compiler, Rust runtime, and examples into a standalone repository.
- Add `npx quint-refinements new` and `compile` commands that derive the conformance artifact and Rust adapter from Quint's parser output.
- Organize the compiler, Rust runtime, and cross-package examples as independently publishable monorepo workspaces.
