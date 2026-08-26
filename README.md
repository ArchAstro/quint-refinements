# quint-refinements

`quint-refinements` checks that a Rust implementation follows scenarios generated from a [Quint](https://quint.sh/) model. A Rust primitive declares which Quint action or ordered action sequence it owns, executes once, returns observable snapshots, and the crate evaluates every generated guard and next-state obligation.

```text
Quint model -> generated JSON -> ownership scheduler -> real Rust command
                                                     -> evidence snapshots
                         generated obligations <---- refinement evaluator
```

## What it proves

1. Every scenario action has an explicit implementation owner.
2. One implementation command may refine one action or an ordered 1-to-N action sequence.
3. The command returns exactly one evidence snapshot per owned action.
4. Rust fixtures match the values generated from Quint.
5. Guards and complete next-state assignments hold over the returned snapshot tape.

The crate does not decide which scenarios a product must cover. Coverage policy remains in the consuming project.

## Quick start

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

New to refinement checking? Follow the [bank tutorial](docs/tutorial.md), which mirrors Quint's Getting Started flow and ends in a complete copyable project.

| Example | Demonstrates | Command |
|---|---|---|
| `bank_account` | Step-by-step standalone project from Quint model to Rust refinement test | `cargo run --manifest-path examples/bank_account/Cargo.toml` |
| `two_phase_commit` | Full Quint model, generated traces, fixtures, 1-to-N ownership, exact state assignments | `cargo run --example two_phase_commit` |
| `two_phase_commit_async` | The same scenario through the runtime-neutral async driver | `cargo run --example two_phase_commit_async` |
| `ownership_records` | One-step ownership, aliases, compound sequences, deterministic aggregation | `cargo run --example ownership_records` |
| `fixture_ownership` | Rust-owned Quint fixtures and drift validation | `cargo run --example fixture_ownership` |
| `structural_values` | Lossless ITF records, maps, sets, tuples, and variants | `cargo run --example structural_values` |
| `failure_modes` | Fail-closed behavior for partial action sequences and short evidence tapes | `cargo run --example failure_modes` |

The [examples guide](examples/README.md) provides an ordered learning path. Start with `ownership_records`, then run the two-phase commit example. Its files are intentionally kept together under [`examples/two_phase_commit`](examples/two_phase_commit):

- `model.qnt` is the executable specification.
- `app-config.mjs` declares the model entry points and retrieve vocabulary.
- `generate-traces.mjs` invokes the reusable generator.
- `traces.json` is checked-in generated evidence.
- `coordinator.rs` is the implementation adapter used by sync and async examples.

## Generate and verify traces

The JavaScript generator is part of the distribution because it extracts complete refinement obligations from Quint's Informal Trace Format.

```console
npm ci
npm run check:traces
# After an intentional model or generator change:
npm run generate:traces
```

The Quint version is pinned in `package.json`. Generated trace drift fails CI.

## Fixtures and evidence

`FixtureTable` binds stable model names, such as identifiers and finite universe sets, to Rust values implementing `QuintFixture`. `FixtureTable::validate` fails when generated JSON and Rust values diverge.

Live snapshots implement `NormalizedRuntimeEvidence`. The name `state` conventionally resolves to the complete observed model state; domain-specific calls may be implemented through `resolve_call`.

Assignments are exact: for `state' = expression`, the right side is evaluated against the current snapshot and compared with the complete next snapshot. Structural map keys and set members are preserved rather than converted to strings.

## Development

```console
npm ci
npm run check:traces
cargo test --locked --all-targets
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo package --locked
```

The minimum supported Rust version is 1.85. The project is licensed under the MIT License.
