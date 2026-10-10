# Model annotations and rules

A model is ordinary Quint. The compiler reads two annotations and expects three conventions.

## Annotations

| Annotation | Where | Meaning |
|---|---|---|
| `/// @conformance` | The doc comment directly above a `run` | The implementation must follow this scenario. |
| `/// @primitive name = [a, b, c]` | The module's doc comment | One implementation command performs actions `a`, `b`, `c`, in that order. |

### `@conformance`

```quint
/// @conformance
run withdrawRun = init
  .then(withdraw(4))
  .then(all {
    assert(state.balance == 6),
    state' = state,
  })
```

1. A run without the annotation stays an ordinary Quint test and is ignored.
2. Each annotated run becomes one scenario named `module.runName`.

### `@primitive`

```quint
/// @primitive commit = [prepare, flushWal, commitPrepared]
module two_phase_commit {
```

1. The generated trait gets one `commit` method in place of three, and it returns one snapshot per action.
2. Every listed action must be called by at least one `@conformance` run.
3. An action belongs to at most one `@primitive`. Actions not listed get their own method.

The [guide](../guides/one-command-many-actions.md) builds a complete example.

## Conventions

The compiler enforces each of these and says how to fix a model that breaks one.

### 1. State lives in one record named `state`

```quint
type State = { balance: int, frozen: bool }
var state: State
```

The checker compares one snapshot of the implementation with the model's state, field by field. A model with several `var` declarations, or a `state` that is not a record, is rejected.

### 2. A scenario is an initializer, then actions, then an observation

```quint
run name = init
  .then(action1(...))
  .then(action2(...))
  .then(all {
    assert(...),
    state' = state,
  })
```

1. The observation block holds only `assert(...)` conjuncts and `state' = state`.
2. A scenario must assert something.

### 3. All scenarios share one initializer

Every scenario starts with the same initializer action. To start from different states, add setup actions after it.

## What becomes an obligation

For each action a scenario calls, the action's body is split into conjuncts:

| In the action | Becomes | Checked against |
|---|---|---|
| A conjunct without `state'` | A guard | The snapshot before the action |
| `state' = ...` | The next-state assignment | The complete snapshot after the action |
| No single assignment (`if`/`else`, `any`, `nondet`) | The state Quint reached | The complete snapshot after the action |

Parameters are substituted, so `withdraw(4)` yields the guard `4 > 0`.

## Constants

A named value that a scenario or action refers to is a constant:

```quint
pure val coffee: Order = { id: "coffee", total: 30 }
```

1. Quint evaluates it, and the value is stored in the scenario file.
2. A scenario that calls `pay(coffee)` hands your Rust method that record. No Rust is needed to declare it.
3. To tie a constant to a production value, override `fixtures`. See [generated Rust](rust.md#fixtures).

## Several files

Scenarios may import their model:

```quint
module scenarios {
  import shop.* from "./shop"
  ...
}
```

Compile the file that holds the scenarios. When more than one module declares `@conformance` runs, choose one with `--module`. The [shop guide](../guides/shop-orders.md) builds a two-file model.

## Supported expressions

Guards, assignments and assertions are evaluated by the Rust runtime, which supports the Quint operators listed in [`expression_vocabulary.json`](../../packages/compiler/expression_vocabulary.json). The compiler names any operator outside that set.

## Names

Action names become snake_case Rust methods: `flushWal` becomes `flush_wal`. `from_initial_state`, `snapshot`, `fixtures` and Rust keywords are taken, and two actions may not map to the same method name.
