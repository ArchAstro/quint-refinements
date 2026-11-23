# Adapters: connecting the model to code

`compile` generates the interface. You write the implementation of it. This page is about writing that implementation so the replay checks production code and not a story about it.

## 1. What you implement

| Piece | Job |
|---|---|
| `from_initial_state` | Build the real system in the scenario's starting state |
| One method per action (or per `@primitive`) | Parse the arguments, call production code |
| `snapshot` | Read the real system and return it as the model's `state` record |
| `fixtures` (optional) | Bind model constants to production constants |

Names differ per language (`fromState`, `Snapshot()`, callbacks in Elixir); the generated file is the authority. Keep the adapter thin. Logic in the adapter is logic the replay does not check.

## 2. Action methods

1. Parse arguments strictly and return an error on a shape you do not expect. In Rust, slice patterns keep it short:

   ```rust
   let [RuntimeValue::Text(machine)] = arguments else {
       return Err(format!("claim expects one machine: {arguments:?}"));
   };
   ```

2. Call the production function. Widen visibility to the crate or add one read-only accessor if you must; do not add a hook to production code that exists only to steer the test.
3. Map symbolic model values to real ones in one table (`"t1"` to a real timestamp, model id `p1` to a real record id), and map them back in `snapshot`. Prefix real keys per scenario so runs do not collide in a shared database.
4. Turn abstract inputs into real ones here: `delayPassed: true` becomes a timestamp older than the retry delay.

## 3. Snapshots

The check trusts the snapshot. These rules keep it honest.

1. **Read from the real system.** The database rows, the struct after the call, the server's answer. For each field, be able to say where it was read from. A field derived from the test's own bookkeeping passes no matter what the code did.
2. **Report every field of `state`.** A missing one fails with `state record fields differ; missing [...]`.
3. **Report whole maps.** A map that an obligation reads is compared as reported, so an entry the model has and the snapshot lacks fails with `missing from observed state`. Runtimes up to release 0.2.0 filled such gaps from the model, and code that dropped entries passed.
4. **Know which fields are compared.** After the initial state, the runtime compares the fields that the step's guards, assignment or assertions read. A field of `state` that no action or assertion in any scenario reads keeps the model's value, and the code can change it unnoticed. Give every field a scenario that reads it.
5. **Map exactly.** If one model unit stands for 100 production units and production holds 200, the snapshot says 2. If it holds 201, the snapshot returns an error. No integer division, no truncation.
6. **Compute derived observables with production code.** If the model has a derived flag, call the production function that decides it; do not restate its rule.
7. **Make wrong values visible.** Use a different value for each day or key, so reading the wrong one changes the result.

Test the snapshot itself: convert the model's initial state into the system and back, and require equality. Then, for each field, replace it with an empty value in snapshots taken after an action (not only the first one) and confirm the replay fails. A field whose blanking goes unnoticed is not being compared.

## 4. Fixtures

A named constant in the model reaches the code with no extra work. Override `fixtures` to bind a constant to the production value, so the two cannot drift:

```rust
fn fixtures(artifact: &ConformanceArtifact) -> Result<FixtureTable, String> {
    // "scenarios" is the name of the compiled module.
    Ok(FixtureTable::from_artifact("scenarios", artifact)
        .map_err(|error| error.to_string())?
        .insert("MAX_RETRIES", &MAX_RETRIES))
}
```

The bound value must implement `QuintFixture` (provided for `i64`, strings and sets of them; implement it for your own types). When someone changes the production constant, the run fails with `fixture MAX_RETRIES JSON diverged` before any scenario runs. The [generated Rust reference](https://github.com/ArchAstro/quint-refinements/blob/main/docs/reference/rust.md) has the full form.

## 5. What to assert around the replay

1. The scenario list. Compare the names in the artifact with an explicit list, so a dropped or renamed scenario fails.
2. Every scenario evaluated at least one obligation.
3. Optionally, the obligation count per scenario. A count that drops means guards stopped being checked, for example because an action moved to reached-state checking.
4. For one deliberately wrong implementation, the exact divergence message. This keeps a test that proves the replay can fail.

## 6. Reading a divergence

```text
scenarios.retriesOnceRun:resume next: assign state diverged at state.retries expected Int(1), observed Int(2)
```

`expected` is the model. `observed` is your snapshot. Work in this order:

1. **Adapter.** Did `from_initial_state` build the starting state completely? Did the method pass the right arguments? Is the snapshot mapping right? Most first-run divergences end here.
2. **Model.** Is the model's rule what production is meant to do? If not, fix the model.
3. **Product.** If the model is right and the adapter is right, you have a bug with a scenario that reproduces it.

`guard assertion evaluated false` means the code reached a state where the model does not allow the action. Look at the step before.

## 7. Code that does I/O

Pick the smallest setup that still runs the code that matters, and say which one you picked.

| Setup | Drives | Good for |
|---|---|---|
| Pure core | The extracted `apply` or `decide` functions | Decision logic. Runs in milliseconds. The I/O shell needs a separate integration test |
| Real storage | Each machine as a real database with the real schema; a fake for the remote service | Persistence and recovery |
| Gated store | The real client, with each request held until the scenario releases it as answered, lost or dropped | Races and lost replies in async code |
| Stepped database connections | Real connections paused after each SQL statement | Lock ordering and isolation |
| Real server | The real process over its real routes and database | The whole path, in its own slower test job |

Notes on the harder ones:

1. **Gated store.** Wrap the store client. A request the model counts as a step blocks until the scenario's next action releases it with an outcome. After each action, wait until released requests have been answered, then snapshot.
2. **Stepped connections.** Pause each caller after every statement using an instrumentation point the database library already has, with nothing added to production code. Read locks and waiters from the database's own views (for PostgreSQL, `pgrowlocks` and `pg_blocking_pids`). Read uncommitted rows from the statement's parameters, because a paused connection cannot be queried. Fail the step on any statement the harness does not recognise, so a new statement cannot go unnoticed.
3. **Crashes.** Kill the worker process where it stands and start a fresh one under the same name. That closes its connection and rolls back its transaction, which is what a crash does.
4. **Faults.** Prefer real state that makes production refuse (remove the record the call depends on for the length of one action) over an injected error.
5. **Time.** Inject a clock or pause the runtime's clock. One model tick maps to a fixed real step.
6. **Cleanup.** Rows committed on real connections outlive the test's transaction. Track what you create and delete it, then assert the database is back where it started. Check for leaked worker processes holding connections.

## 8. Fakes and fidelity

1. A fake of a remote service is a hand-written copy of that service's rules. A race shown against the copy is shown against the copy. Confirm the real behavior by reading or running the real service, and say so.
2. If a step in the adapter copies private production logic, the comparison for that step is circular. Do not make private functions public only for the test; record the gap and plan a test that drives the real path.
3. A refinement of the pure core does not cover the I/O shell. When the shell changes (a new storage backend), the refinement will not notice. Either drive the shell in the replay or keep a named integration test for it, and add model actions for what the shell can do that the core cannot (a write that applied but whose reply was lost).
4. In the write-up, list per piece: runs for real, faked, and what the fakes share that production does not.

## 9. Stability

1. Run a replay that touches processes, sockets or a database 10 to 50 times in a row before calling it green. Report failures you could not explain; do not raise a timeout to hide them.
2. Run long replays in release or optimized mode.
3. Parse a large artifact once per process and reuse it across scenarios.
