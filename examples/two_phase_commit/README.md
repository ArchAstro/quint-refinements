# Two-phase commit example

Postgres is not here. The model is the three durable steps a commit must
take: write PREPARE, flush WAL, write COMMIT. The client still calls one
function.

```
Quint:  begin → prepare → flushWal → commitPrepared
Rust:   begin() ; commit()
                  └── prepare, flush, commitPrepared (one command, three snapshots)
```

That 1-to-N mapping is `refines` on `postgres.txn.commit`. The scheduler
runs `commit()` once and demands three evidences.

```rust
quint_ownership! {
    pub const COMMIT_OWNERSHIP = {
        primitive: "postgres.txn.commit",
        refines: ["prepare", "flushWal", "commitPrepared"],
        observations: ["path:state.status", "path:state.flushed", "path:state.wal_len"],
    };
}
```

`traces.json` is the checked artifact for `commitRun`. `model.qnt` typechecks
with Quint (`quint typecheck model.qnt`).

```
cargo test --test two_phase_commit
cargo run --example two_phase_commit
```
