# Two-phase commit example

Postgres is not here. The model is the three durable steps a commit must
take: write PREPARE, flush WAL, write COMMIT. The client still calls one
function.

```
Quint:  begin → prepare → flushWal → commitPrepared
Rust:   begin() ; commit()
                  └── prepare, flush, commitPrepared (one command, three snapshots)
```

That 1-to-N mapping is one line in the module comment of `model.qnt`:

```quint
/// @primitive commit = [prepare, flushWal, commitPrepared]
module two_phase_commit {
```

From it the compiler generates one trait method. The runner calls it once and
requires a snapshot after each of the three actions:

```rust
fn commit(&mut self, actions: &[ResolvedAction]) -> Result<Vec<Self::Evidence>, String>;
```

| File | Role |
|---|---|
| `model.qnt` | The specification, with its two `@conformance` runs |
| `traces.json` | Generated scenarios and obligations |
| `generated.rs` | Generated ownership, `Implementation` trait, and runner |
| `coordinator.rs` | The implementation: `Coordinator` and its `Implementation` |

`Status` owns the Quint `statuses` universe through `fixtures()`, so the guard
`statuses.contains(state.status)` is evaluated against the Rust enum.
`state.status`, `state.wal`, and `state.flushed` come from the real
coordinator snapshot.

```
# From the repository root:
npm run generate          # after changing model.qnt
npm run check:generated   # what CI runs
cargo test --manifest-path bindings/rust/Cargo.toml --test two_phase_commit
cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit
```
