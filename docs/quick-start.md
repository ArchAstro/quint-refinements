# Quick start

Five minutes: create a project that already passes, then break it to see what a failure looks like.

You need [Node.js](https://nodejs.org) 22 or newer and [Rust](https://rustup.rs) 1.85 or newer.

## 1. Create a project

```console
npx quint-refinements new my-check
cd my-check
cargo run
```

```text
counter.incrementRun refined 1 obligations
```

The project passes before you change anything. It has four files that matter:

| File | Who writes it | What it is |
|---|---|---|
| `model.qnt` | You | The Quint model and its scenarios |
| `src/main.rs` | You | The implementation under test |
| `quint-refinements.json` | The compiler | Scenarios, guards and next-state obligations |
| `src/generated_refinement.rs` | The compiler | A typed `Implementation` trait and the runner |

## 2. Read the model

<!-- from packages/compiler/cli.mjs -->
```quint
module counter {
  type State = { count: int }

  var state: State

  action init = all {
    state' = { count: 0 },
  }

  action increment = all {
    state' = { count: state.count + 1 },
  }

  /// @conformance
  run incrementRun = init
    .then(increment)
    .then(all {
      assert(state.count == 1),
      state' = state,
    })
}
```

1. `/// @conformance` marks `incrementRun` as a scenario the Rust code must follow.
2. `increment` has one obligation: after it runs, `state` equals `{ count: state.count + 1 }`.

## 3. Break the implementation

In `src/main.rs`, the `increment` method runs `self.count += 1;`. Change it to `self.count += 2;` and run again:

```console
cargo run
```

```text
refinement failed: counter.incrementRun:increment next: assign state diverged at state.count expected Int(1), observed Int(2)
```

The message names the scenario, the action, the field, the model's value and the code's value. Undo the change.

## 4. Change the model

Add an action to `model.qnt`, inside the module:

```quint
  action reset = all {
    state' = { count: 0 },
  }

  /// @conformance
  run resetRun = init
    .then(increment)
    .then(reset)
    .then(all {
      assert(state.count == 0),
      state' = state,
    })
```

Regenerate, then build:

```console
npx quint-refinements compile
cargo run
```

```text
error[E0046]: not all trait items implemented, missing: `reset`
```

The generated trait gained a `reset` method, and the Rust compiler reports that `src/main.rs` does not have it yet. Add it to the `impl Implementation` block:

```rust
    fn reset(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.count = 0;
        Ok(())
    }
```

```console
cargo run
```

```text
counter.incrementRun refined 1 obligations
counter.resetRun refined 2 obligations
```

That is the whole loop: edit the model, compile, let `cargo` say what is missing, run.

## Next

1. [Tutorial: a bank account](tutorial.md) builds a project from an empty model, with arguments and guards.
2. [How it works](how-it-works.md) explains what is generated and what is checked.
3. [Troubleshooting](troubleshooting.md) lists every message and what to change.
