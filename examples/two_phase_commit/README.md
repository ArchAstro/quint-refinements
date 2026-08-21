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
        observations: ["path:state.status", "path:state.flushed", "path:state.wal"],
    };
}
```

`Status` owns the generated Quint `statuses` universe; unit constructors remain
structural Quint tags. `state.status`, `state.wal`, and `state.flushed` come
from the real coordinator snapshot.

`traces.json` is generated from `model.qnt` through this app's explicit source,
initializer, step, vocabulary, retrieve, and fixture configuration.

```
node generate-traces.mjs --check
cargo test --test two_phase_commit
cargo test --test generated_two_phase_commit
cargo run --example two_phase_commit
```
