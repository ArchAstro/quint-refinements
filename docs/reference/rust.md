# Generated Rust

`compile` writes one Rust module, `src/generated_refinement.rs`. You implement its trait; it does the rest. The snippets on this page come from the [`transaction_commit`](../../examples/rust/transaction_commit) example.

| Item | What it is |
|---|---|
| [`Implementation`](#the-implementation-trait) | The trait you implement |
| [`refine_all`](#refine_all) | Runs every scenario against a fresh implementation |
| [`ScenarioResult`](#refine_all) | What `refine_all` returns per scenario |
| [`Driver`, `OWNERSHIP`, `RETRIEVE`, `artifact`](#driving-scenarios-yourself) | The pieces `refine_all` is built from |

The file starts with `// @generated`. Never edit it; change the model and compile again.

## The `Implementation` trait

<!-- from examples/rust/transaction_commit/src/generated_refinement.rs -->
```rust
/// Domain implementation connected to the generated Quint scenarios.
pub trait Implementation: Sized {
    /// Snapshot type exposed to the refinement evaluator.
    type Evidence: NormalizedRuntimeEvidence + Clone;

    /// Construct the implementation from a scenario's generated initial state.
    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String>;

    /// Return the current observable implementation state.
    fn snapshot(&self) -> Self::Evidence;

    /// Values for the constants the model names, such as `pure val limit = 3`.
    ///
    /// By default each constant has the value the model gives it. Override
    /// this to bind a constant to a production value instead; the runner then
    /// fails if that value and the model disagree.
    fn fixtures(artifact: &ConformanceArtifact) -> Result<FixtureTable, String> {
        FixtureTable::from_artifact("two_phase_commit", artifact).map_err(|error| error.to_string())
    }

    /// Execute Quint action `abort` with its generated arguments.
    fn abort(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;

    /// Execute Quint action `begin` with its generated arguments.
    fn begin(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;

    /// Execute Quint actions `prepare`, `flushWal`, `commitPrepared` as one command.
    ///
    /// Return one snapshot taken after each action, in that order.
    fn commit(&mut self, actions: &[ResolvedAction]) -> Result<Vec<Self::Evidence>, String>;
}
```

| Member | You provide |
|---|---|
| `Evidence` | Your snapshot type. It answers `resolve_name("state")` with the whole state record. |
| `from_initial_state` | Your implementation, built from the state the model's initializer produces. |
| `snapshot` | The current observable state. Called after every action. |
| One method per action | The call into your real code. `arguments` are the values the scenario passes. |
| One method per `@primitive` | The call, plus one snapshot after each action it owns. |
| `fixtures` | Optional. See [fixtures](#fixtures). |

A method that returns `Err` fails the scenario with that message.

## Values

Arguments, the initial state and snapshots are all `RuntimeValue`:

| Quint | `RuntimeValue` |
|---|---|
| `bool` | `Bool(bool)` |
| `int` | `Int(i64)` |
| `str`, or a variant with no payload such as `Open` | `Text(String)` |
| `Set[T]` | `Set(BTreeSet<RuntimeValue>)` |
| `List[T]` | `List(Vec<RuntimeValue>)` |
| Tuple | `Tuple(Vec<RuntimeValue>)` |
| `a -> b` | `Map(BTreeMap<RuntimeValue, RuntimeValue>)` |
| Record | `Record(BTreeMap<String, RuntimeValue>)` |
| A variant with a payload | `Variant { tag, value }` |

Pattern-match to take arguments apart:

```rust
let [RuntimeValue::Int(amount)] = arguments else {
    return Err(format!("withdraw expects one integer: {arguments:?}"));
};
```

## Snapshots

A snapshot implements `NormalizedRuntimeEvidence`. `resolve_name("state")` returns the model's `state` record built from real implementation state:

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

The check is only as honest as the snapshot. Read the fields from the code under test; do not compute what the model expects.

## Fixtures

By default every model constant has the value the model gives it, and you write nothing. Override `fixtures` to bind a constant to a production value:

<!-- from examples/rust/transaction_commit/src/main.rs -->
```rust
    fn fixtures(artifact: &ConformanceArtifact) -> Result<FixtureTable, String> {
        Ok(FixtureTable::from_artifact("two_phase_commit", artifact)
            .map_err(|error| error.to_string())?
            .insert_set("statuses", &STATUSES))
    }
```

| Method | Effect |
|---|---|
| `FixtureTable::from_artifact(module, artifact)` | Start with the model's value for every constant. |
| `.insert(name, &value)` | Bind one constant to a Rust value. |
| `.insert_set(name, &values)` | Bind a set constant to a Rust slice. |

Bound values implement `QuintFixture`. Before any scenario runs, each bound value is compared with the model's, and a difference fails the run.

## `refine_all`

<!-- from examples/rust/transaction_commit/src/generated_refinement.rs -->
```rust
/// Result of refining one generated Quint run.
pub struct ScenarioResult<I> {
    /// Fully qualified generated scenario name.
    pub scenario: String,
    /// Number of evaluated guard and next-state obligations.
    pub evaluated_obligations: usize,
    /// Implementation state after the scenario completed.
    pub implementation: I,
}
```

`refine_all::<YourType>()` returns one `ScenarioResult` per scenario, or the first divergence as an `Err`. Call it from `main`, from a `#[test]`, or both:

```rust
#[test]
fn the_implementation_refines_the_model() {
    refine_all::<Transaction>().expect("every scenario refines");
}
```

## Driving scenarios yourself

`refine_all` is a short loop over public pieces. Use them directly when you need async commands, shared setup between scenarios, or your own reporting.

| Item | What it is |
|---|---|
| `artifact()` | The parsed scenario file this module was compiled with |
| `OWNERSHIP` | Which implementation command owns each Quint action |
| `RETRIEVE` | Everything the obligations may read from a snapshot |
| `Driver<I>` | Dispatches actions to your `Implementation`; works with the sync and async runners |

The loop `refine_all` runs for each scenario:

<!-- from examples/rust/transaction_commit/src/generated_refinement.rs -->
```rust
        let initial_state = RuntimeValue::from_itf_json(initial_json)?;
        let implementation = I::from_initial_state(&initial_state)?;
        let initial_evidence = implementation.snapshot();
        let mut driver = Driver { implementation };
        let evaluated_obligations = refine_scenario(
            scenario,
            initial_evidence,
            &ownership,
            RETRIEVE,
            &fixtures,
            &mut driver,
        )?;
```

`refine_scenario_async` takes the same arguments for an async driver, and `RefinementSession` steps through a scenario one command at a time. The [crate documentation](https://docs.rs/quint-refinements) covers the runtime API.
