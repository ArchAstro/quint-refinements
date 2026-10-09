# Troubleshooting

Find the message you got. Each entry says what it means and what to change.

## From `quint-refinements compile`

### `Quint rejected the model:` followed by `file:line:col: [QNT...] ...`

The model itself does not parse or typecheck. The location and message come from Quint. Fix the model; `quint typecheck model.qnt` gives the same answer.

### `declares state variables [a, b]; keep the whole model state in one var state`

The checker compares one snapshot of your implementation with the model's state, so the model needs one state variable, named `state`. Move the variables into a record:

```quint
type State = { balance: int, frozen: bool }
var state: State
```

### ``declares `var state` as a int; make it a record``

`state` must be a record, even with one field, so obligations can name the fields they read: `var state: { count: int }`.

### `expected exactly one @conformance directive` / `malformed @conformance directive`

Write the annotation on its own doc-comment line directly above the run:

```quint
/// @conformance
run withdrawRun = init.then(withdraw(4)).then(all { assert(state.balance == 6), state' = state })
```

### `run has no asserted observation`

A scenario must assert something. End it with an observation block.

### ``an observation block is `all { assert(...), state' = state }` ``

An observation block may contain only `assert(...)` conjuncts and the unchanged state. Put several conditions in one assertion with `assert(all { a, b })`, or use several `assert` lines.

### `must begin with a named initializer` / `conformance runs must share one initializer`

Every scenario starts with the same initializer action, as in `init.then(...)`. To start scenarios from different states, add setup actions after the shared `init`.

### `expected one module with conformance runs, found N: ...`

Several modules in the file (or its imports) declare scenarios. Choose one: `compile model.qnt --module scenarios`.

### `malformed @primitive directive` / `@primitive X owns Y, which no conformance run executes` / `Y is owned by both ...`

The line goes in the module's doc comment and lists action names in the order the command performs them:

```quint
/// @primitive commit = [prepare, flushWal, commitPrepared]
module two_phase_commit {
```

Every listed action must be called by at least one `@conformance` run, and belong to only one `@primitive`.

### `maps to reserved Rust name` / `both map to Rust identifier`

Action names become snake_case Rust methods. `from_initial_state`, `snapshot`, `fixtures` and Rust keywords such as `match` are taken, and `flushWal` and `flush_wal` collide. Rename the action in the model, or group it under a `@primitive` with another name.

### `uses unsupported normalized operators ...`

A guard, assignment or assertion uses a Quint operator the Rust runtime cannot evaluate. The supported set is in [`expression_vocabulary.json`](../packages/compiler/expression_vocabulary.json). Rewrite the expression with supported operators, or move the logic into an action whose effect is checked by state.

### `quint-refinements.json drifted; run quint-refinements compile`

You ran `compile --check` and a generated file no longer matches the model. Run `npx quint-refinements compile` and commit the result. See the [CI guide](guides/ci.md).

### `could not start rustfmt`

The compiler formats the Rust it generates. Install Rust from <https://rustup.rs>, then `rustup component add rustfmt`.

## From `cargo`

### `error[E0046]: not all trait items implemented, missing: ...`

The model has an action your implementation does not handle yet. Add the listed methods to your `impl Implementation`. This is the intended signal after a model change.

### `error[E0407]: method ... is not a member of trait Implementation`

The model no longer has that action (or it moved into a `@primitive`). Delete the method.

### `failed to select a version for the requirement quint-refinements = ...`

The crate version must match the compiler version in `package.json`. They release together under one number.

## From `cargo run` / `cargo test`

### `... next: assign state diverged at state.FIELD expected X, observed Y`

Your code took the step, and the state afterwards is not what the model's assignment produces. `expected` is the model, `observed` is your snapshot. The scenario and action names at the front say where. See [reading a failure](how-it-works.md#5-reading-a-failure).

If the field is one the action should not touch, the code changed something extra: the comparison covers the whole state.

### `guard assertion evaluated false`

The implementation reached a state in which the model does not allow the action. Usually an earlier step left the state subtly wrong, or `from_initial_state` did not build the scenario's starting state.

### `primitive X owns N actions but returned M evidence snapshots`

A `@primitive` method must return one snapshot after each action it owns, in order. See the [guide](guides/one-command-many-actions.md).

### `fixture NAME JSON diverged: artifact ... rust ...`

You bound a model constant to a Rust value in `fixtures`, and the two differ. Either the code or the model gained or lost a value. Delete the override to use the model's value as is.

### `fixture namespace M names differ: artifact [...] rust [...]`

Your `fixtures` override returns a table that does not cover every constant. Start from the model's values and replace only what you bind:

```rust
FixtureTable::from_artifact("module_name", artifact)
    .map_err(|error| error.to_string())?
    .insert_set("statuses", &STATUSES)
```

### `unknown model name ...` (or whatever your `resolve_name` returns)

An obligation asked your snapshot for a name it does not provide. `resolve_name("state")` must return the whole state record.

## Still stuck

Open an issue at <https://github.com/ArchAstro/quint-refinements/issues> with the model, the command and the full message.
