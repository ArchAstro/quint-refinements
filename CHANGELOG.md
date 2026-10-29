# Changelog

This project follows [Semantic Versioning](https://semver.org/). The compiler
and the Rust, Go and TypeScript runtimes share one version.

## Unreleased

### Changed

- Artifact schema version 3: the artifact stores each distinct list of guards
  or next-state obligations once in a top-level `assertionLists`, and an action
  step names its lists by index with `guardList` and `nextList`. Steps used to
  repeat their full expression trees, so a model with many scenarios produced
  an artifact of hundreds of megabytes that held a few dozen distinct lists.
  The order is first appearance, so output is deterministic. The compiler
  emits version 3 for both `--compact` and indented output.
- The Rust, Go and TypeScript runtimes read versions 2 and 3, resolving
  references at load so evaluation is unchanged. They reject an index outside
  `assertionLists`, a file that mixes the inline and indexed forms, and a schema
  version they do not know. `conformance/cases/bank_withdraw_v2` keeps a v2
  artifact in the corpus.

### Fixed

- A map in the observed state is taken as the implementation reports it: an
  entry the model's next state has and the snapshot lacks is now reported as
  `missing from observed state`. Every runtime filled such an entry in from the
  model before comparing, so an implementation that dropped one (a deleted
  row, a forgotten key) refined. Records still merge field by field.

- `matchVariant` takes Quint's `_` default branch (`match v { | A => … | _ => … }`)
  in both runtimes; a value no named branch matched failed with "matchVariant
  has no matching branch".

### Added

- A Go runtime, `github.com/ArchAstro/quint-refinements/bindings/go`, that
  reads the same schema-v2 artifact as the Rust crate with the same
  semantics: `RuntimeValue`, evidence, fixtures, ownership scheduling, and the
  obligation evaluator, with identical divergence messages.
- `compile --go <path>` (and `--go-package`) generates a Go `Implementation`
  interface, ownership and retrieve tables, and a generic `RefineAll`. Without
  `--rust` only the Go adapter is written, and `--check` covers it.
- Go examples (`bank_account`, `raft`, `raft_network`, two-phase commit) whose
  obligation counts equal the Rust examples', and the shared conformance corpus
  runs against the Go runtime.
- `compile --compact` writes the artifact without indentation, about a tenth
  the size for models whose steps inline large obligations.
- A TypeScript runtime, shipped in the npm package as
  `quint-refinements/runtime` with `.d.ts` files and no dependencies. It reads
  the same schema-v2 artifact as the Rust and Go runtimes with the same
  semantics and divergence messages. Quint integers are `bigint`. It has a
  synchronous and an asynchronous driver.
- `compile --typescript <path>` generates a typed `Implementation` interface,
  ownership and retrieve tables, `artifact()`, and `refineAll` /
  `refineAllSync`. Without `--rust` only the TypeScript adapter is written,
  and `--check` covers it.
- TypeScript examples (`bank_account`, `two_phase_commit`, `raft`) whose
  obligation counts equal the Rust examples', and the shared conformance
  corpus runs against the TypeScript runtime.

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
- A documentation site at <https://archastro.github.io/quint-refinements/>,
  built from `docs/`, with a quick start and reference pages for the command
  line, the model annotations and the generated Rust.
- `compile` defaults to `model.qnt` and accepts `--artifact` and `--rust` to
  place generated files in an existing crate.
- The generated module exposes `OWNERSHIP`, `RETRIEVE`, `artifact()` and
  `Driver`, which also implements `AsyncPrimitiveDriver`.
- The compiler rejects models the runtime cannot check (state outside one
  record `var state`, malformed annotations) with a message that names the fix.
- One `vX.Y.Z` tag publishes the crate and the npm package, then runs the
  published quick start.
- A Raft example and guide: leader election, log replication and commit on
  three nodes, with safety invariants checked by simulation in CI, and an
  implementation that uses only the Rust standard library.
- A second Raft example over an unreliable network, where messages can be
  lost, delayed, reordered or duplicated, with its own guide.

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

- A divergence inside a map-valued field names the key, as in
  `state.nodes["n1"].role`, instead of printing both whole maps.
- `and`, `or`, `actionAll` and `actionAny` stop at the first argument that
  decides the result, as in Quint. A guard such as
  `l.length() > i and l[i] == x` no longer fails with an out-of-bounds error.
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
