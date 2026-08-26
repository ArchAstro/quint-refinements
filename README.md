# quint-refinements

`quint-refinements` compiles annotated [Quint](https://quint.sh/) scenarios into implementation checks. The current Rust binding declares which Quint action or ordered action sequence a primitive owns, executes it once, returns observable snapshots, and evaluates every generated guard and next-state obligation.

```text
Quint model -> generated JSON -> ownership scheduler -> real Rust command
                                                     -> evidence snapshots
                         generated obligations <---- refinement evaluator
```

## What the Rust binding proves

1. Every scenario action has an explicit implementation owner.
2. One implementation command may refine one action or an ordered 1-to-N action sequence.
3. The command returns exactly one evidence snapshot per owned action.
4. Rust fixtures match the values generated from Quint.
5. Guards and complete next-state assignments hold over the returned snapshot tape.

The compiler and bindings do not decide which scenarios a product must cover. Coverage policy remains in the consuming project.

## Repository layout

This repository keeps the language-neutral compiler and all runtime bindings on one conformance corpus. Each binding remains independently publishable and versioned.

```text
packages/compiler/          Quint AST, generated artifact, and npx CLI implementation
bindings/rust/              Rust runtime published to crates.io
examples/rust/bank_account  Complete compiler-to-Rust tutorial project
conformance/                Shared artifact schema and golden binding cases
```

Future runtimes belong under `bindings/<language>`. Cross-language example projects belong under `examples/<language>`.

## Quick start

Create a project and generate its Rust boundary from Quint:

```console
npx quint-refinements new bank-refinement
cd bank-refinement
# Edit model.qnt until Quint accepts the model.
npx quint-refinements compile model.qnt
cargo run
```

The compile command reuses Quint's parser and AST. It generates the scenario artifact, ownership records, action dispatch, expression registry, and Rust refinement runner. You implement only the generated Rust action hooks and observable snapshots. See the [step-by-step tutorial](docs/tutorial.md).

For advanced integrations, the ownership API is also available directly:

```rust
use quint_refinements::quint_ownership;

quint_ownership! {
    pub const COMMIT = {
        primitive: "database.transaction.commit",
        refines: ["prepare", "flushWal", "commitPrepared"],
        aliases: [],
        observations: ["path:state.status", "path:state.wal"],
        retrieve: ["name:state"],
    };
}
```

Implement `PrimitiveDriver` or `AsyncPrimitiveDriver`, then pass the generated scenario, initial evidence, ownership descriptors, fixtures, and driver to `refine_scenario` or `refine_scenario_async`.

## Examples

New to refinement checking? Follow the [bank tutorial](docs/tutorial.md), which mirrors Quint's Getting Started flow and ends in a complete generated project.

| Example | Demonstrates | Command |
|---|---|---|
| `bank_account` | Step-by-step standalone project from Quint model to Rust refinement test | `cargo run --manifest-path examples/rust/bank_account/Cargo.toml` |
| `two_phase_commit` | Full Quint model, generated traces, fixtures, 1-to-N ownership, exact state assignments | `cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit` |
| `two_phase_commit_async` | The same scenario through the runtime-neutral async driver | `cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit_async` |
| `ownership_records` | One-step ownership, aliases, compound sequences, deterministic aggregation | `cargo run --manifest-path bindings/rust/Cargo.toml --example ownership_records` |
| `fixture_ownership` | Rust-owned Quint fixtures and drift validation | `cargo run --manifest-path bindings/rust/Cargo.toml --example fixture_ownership` |
| `structural_values` | Lossless ITF records, maps, sets, tuples, and variants | `cargo run --manifest-path bindings/rust/Cargo.toml --example structural_values` |
| `failure_modes` | Fail-closed behavior for partial action sequences and short evidence tapes | `cargo run --manifest-path bindings/rust/Cargo.toml --example failure_modes` |

The [examples guide](examples/README.md) provides an ordered learning path. The bank example is the generated default. The two-phase commit example demonstrates the advanced manual API for a compound Rust primitive that owns multiple Quint actions. Its files are intentionally kept together under [`bindings/rust/examples/two_phase_commit`](bindings/rust/examples/two_phase_commit):

- `model.qnt` is the executable specification.
- `app-config.mjs` declares the model entry points and retrieve vocabulary.
- `generate-traces.mjs` invokes the reusable generator.
- `traces.json` is checked-in generated evidence.
- `coordinator.rs` is the implementation adapter used by sync and async examples.

## Advanced manual generation

The public CLI wraps the JavaScript generator and derives ordinary one-action ownership from Quint's AST. The lower-level generator remains available for integrations such as two-phase commit, where one production primitive deliberately owns an ordered sequence of Quint actions.

```console
npm ci
npm run check:traces
# After an intentional model or generator change:
npm run generate:traces
```

The Quint version is pinned in the root npm package. Generated trace drift fails CI.

## Fixtures and evidence

`FixtureTable` binds stable model names, such as identifiers and finite universe sets, to Rust values implementing `QuintFixture`. `FixtureTable::validate` fails when generated JSON and Rust values diverge.

Live snapshots implement `NormalizedRuntimeEvidence`. The name `state` conventionally resolves to the complete observed model state; domain-specific calls may be implemented through `resolve_call`.

Assignments are exact: for `state' = expression`, the right side is evaluated against the current snapshot and compared with the complete next snapshot. Structural map keys and set members are preserved rather than converted to strings.

## Development

```console
npm ci
npm test
cargo test --locked --manifest-path bindings/rust/Cargo.toml --all-targets
cargo fmt --manifest-path bindings/rust/Cargo.toml -- --check
cargo clippy --locked --manifest-path bindings/rust/Cargo.toml --all-targets -- -D warnings
cargo package --locked --manifest-path bindings/rust/Cargo.toml
```

The minimum supported Rust version is 1.85. The project is licensed under the MIT License.
