# Guide: one command, several actions

A model is usually finer-grained than the code. A two-phase commit is three steps on paper (write PREPARE, flush the log, write COMMIT) and one `commit()` call in the client. This guide checks that one call against all three steps, then binds a model constant to a Rust value.

The finished project is [`examples/rust/transaction_commit`](../../examples/rust/transaction_commit).

```text
Quint:  begin -> prepare -> flushWal -> commitPrepared
Rust:   begin()  commit()
                 one call, three snapshots
```

## 1. Create the project and write the model

```console
npx quint-refinements new txn-check
cd txn-check
```

Replace `model.qnt`:

<!-- from examples/rust/transaction_commit/model.qnt -->
```quint
/// Tiny two-phase commit. Not Postgres.
///
/// Client `COMMIT` is one implementation command. The model still has three
/// spec steps: write PREPARE, flush WAL, write COMMIT. The Rust example
/// refines those three with one `commit()` call:
///
/// @primitive commit = [prepare, flushWal, commitPrepared]
module two_phase_commit {
  type Status = Idle | Open | Prepared | Committed | Aborted

  type Txn = {
    status: Status,
    wal: List[str],
    flushed: bool,
  }

  /// Closed universe of status tags. Membership is a fixture, not live state.
  pure val statuses = Set(Idle, Open, Prepared, Committed, Aborted)

  var state: Txn

  action init = all {
    state' = { status: Idle, wal: [], flushed: false },
  }

  action begin = all {
    statuses.contains(state.status),
    state.status == Idle,
    state' = { status: Open, wal: [], flushed: false },
  }

  action prepare = all {
    statuses.contains(state.status),
    state.status == Open,
    state' = {
      status: Prepared,
      wal: state.wal.append("prepare"),
      flushed: false,
    },
  }

  action flushWal = all {
    statuses.contains(state.status),
    state.status == Prepared,
    state.flushed == false,
    state' = { ...state, flushed: true },
  }

  action commitPrepared = all {
    statuses.contains(state.status),
    state.status == Prepared,
    state.flushed,
    state' = {
      status: Committed,
      wal: state.wal.append("commit"),
      flushed: true,
    },
  }

  action abort = all {
    state.status == Open or state.status == Prepared,
    state' = { ...state, status: Aborted },
  }

  /// @conformance
  run commitRun = init
    .then(begin)
    .then(prepare)
    .then(flushWal)
    .then(commitPrepared)
    .then(all {
      assert(state.status == Committed),
      state' = state,
    })

  /// @conformance
  run abortBeforePrepareRun = init
    .then(begin)
    .then(abort)
    .then(all {
      assert(state.status == Aborted),
      state' = state,
    })
}
```

Two things to notice:

1. `statuses` is a named constant, and every action checks `statuses.contains(state.status)`.
2. The line `/// @primitive commit = [prepare, flushWal, commitPrepared]` in the module comment says one implementation command performs those three actions, in that order.

## 2. See what the `@primitive` line changes

```console
npx quint-refinements compile
```

Without the `@primitive` line, the generated trait would ask for one method per action:

```rust
fn prepare(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;
fn flush_wal(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;
fn commit_prepared(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;
```

With it, those three become one method that returns a snapshot after each action:

```rust
/// Execute Quint actions `prepare`, `flushWal`, `commitPrepared` as one command.
///
/// Return one snapshot taken after each action, in that order.
fn commit(&mut self, actions: &[ResolvedAction]) -> Result<Vec<Self::Evidence>, String>;
```

`cargo run` now reports what the implementation owes:

```text
error[E0046]: not all trait items implemented, missing: `abort`, `begin`, `commit`
```

## 3. Implement the command

The important part of `src/main.rs` is `commit`. It does all three steps and records the transaction after each one:

<!-- from examples/rust/transaction_commit/src/main.rs -->
```rust
/// The code under test: a transaction with a write-ahead log.
#[derive(Clone)]
struct Transaction {
    status: &'static str,
    wal: Vec<String>,
    flushed: bool,
}

impl Transaction {
    fn begin(&mut self) {
        self.status = "Open";
    }

    fn abort(&mut self) {
        self.status = "Aborted";
    }

    /// One client COMMIT: write PREPARE, flush, write COMMIT.
    /// Returns the transaction as it stood after each of the three steps.
    fn commit(&mut self) -> Vec<Transaction> {
        self.status = "Prepared";
        self.wal.push("prepare".to_owned());
        let prepared = self.clone();

        self.flushed = true;
        let flushed = self.clone();

        self.status = "Committed";
        self.wal.push("commit".to_owned());
        vec![prepared, flushed, self.clone()]
    }
}
```

The snapshot is the transaction itself, exposed as the model's `state` record:

<!-- from examples/rust/transaction_commit/src/main.rs -->
```rust
impl NormalizedRuntimeEvidence for Transaction {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Record(BTreeMap::from([
                (
                    "status".to_owned(),
                    RuntimeValue::Text(self.status.to_owned()),
                ),
                (
                    "wal".to_owned(),
                    RuntimeValue::List(self.wal.iter().cloned().map(RuntimeValue::Text).collect()),
                ),
                ("flushed".to_owned(), RuntimeValue::Bool(self.flushed)),
            ]))),
            other => Err(format!("unknown model name {other}")),
        }
    }

    fn resolve_call(
        &self,
        _operator: &str,
        _arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        None
    }
}
```

The generated hooks forward to it:

<!-- from examples/rust/transaction_commit/src/main.rs -->
```rust
    fn begin(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.begin();
        Ok(())
    }

    fn abort(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.abort();
        Ok(())
    }

    fn commit(&mut self, _actions: &[ResolvedAction]) -> Result<Vec<Transaction>, String> {
        Ok(self.commit())
    }
```

The [finished file](../../examples/rust/transaction_commit/src/main.rs) also has `from_initial_state`, `snapshot` and `main`, which are the same shape as in the [bank tutorial](../tutorial.md).

```console
cargo run
```

```text
two_phase_commit.commitRun refined 14 obligations
two_phase_commit.abortBeforePrepareRun refined 5 obligations
```

## 4. What the checker catches

**A step skipped inside the command.** Delete `self.flushed = true;`:

```text
refinement failed: two_phase_commit.commitRun:flushWal next: assign state diverged at state.flushed expected Bool(true), observed Bool(false)
```

The failure names `flushWal`, the model action inside your single `commit()` that the code did not perform.

**Intermediate states not reported.** Return only the final state, `vec![self.clone()]`:

```text
refinement failed: primitive two_phase_commit.commit owns 3 actions but returned 1 evidence snapshots
```

A command cannot claim three actions and show evidence for one.

## 5. Bind a model constant to production code

So far `statuses` has had the value the model gives it. That is the default, and it needs no Rust.

If your code has its own list of statuses, bind the constant to it instead. The checker then fails when the two disagree, which catches a status added on one side only. Override `fixtures`:

<!-- from examples/rust/transaction_commit/src/main.rs -->
```rust
/// Every status the production code can be in.
const STATUSES: [Status; 5] = [
    Status("Idle"),
    Status("Open"),
    Status("Prepared"),
    Status("Committed"),
    Status("Aborted"),
];

struct Status(&'static str);

impl QuintFixture for Status {
    fn artifact_json(&self) -> serde_json::Value {
        serde_json::json!({ "tag": self.0, "value": { "#tup": [] } })
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Text(self.0.to_owned())
    }
}
```

<!-- from examples/rust/transaction_commit/src/main.rs -->
```rust
    fn fixtures(artifact: &ConformanceArtifact) -> Result<FixtureTable, String> {
        Ok(FixtureTable::from_artifact("two_phase_commit", artifact)
            .map_err(|error| error.to_string())?
            .insert_set("statuses", &STATUSES))
    }
```

`from_artifact` starts from the model's values; `insert_set` hands `statuses` to your array. Add `serde_json = "1.0"` to `Cargo.toml` for the `json!` macro.

Remove `Status("Aborted")` from the array and the run stops before any scenario executes:

```text
refinement failed: fixture statuses JSON diverged: artifact {"#set":[{"tag":"Aborted",...},{"tag":"Committed",...},...]} rust [{"tag":"Committed",...},...]
```

## When to use `@primitive`

1. Use it when one production call performs several model actions and you can observe the state between them.
2. Leave it out when each action maps to its own call. That is the default and needs no annotation.
3. Every action belongs to exactly one command. The compiler rejects an action claimed twice, or a `@primitive` that names an action no scenario runs.

Next: [keep generated files honest in CI](ci.md).
