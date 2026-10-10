# quint-refinements

[![CI](https://github.com/ArchAstro/quint-refinements/actions/workflows/ci.yml/badge.svg)](https://github.com/ArchAstro/quint-refinements/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/quint-refinements)](https://www.npmjs.com/package/quint-refinements)
[![crates.io](https://img.shields.io/crates/v/quint-refinements)](https://crates.io/crates/quint-refinements)
[![docs](https://img.shields.io/badge/docs-archastro.github.io-6d43f5)](https://archastro.github.io/quint-refinements/)

Check that your real code does what your [Quint](https://quint.sh/) model says.

You write the model and the implementation. `quint-refinements` generates everything between them, then runs your code through each scenario and checks every guard and next-state assignment against what the code actually did.

```text
model.qnt ──compile──> quint-refinements.json        scenarios and obligations
                       src/generated_refinement.rs   typed trait and runner
                                  │
your implementation ──────────────┘──> cargo run     pass, or the exact divergence
```

## Quick start

You need Node.js 22 or newer and Rust 1.85 or newer.

```console
npx quint-refinements new my-check
cd my-check
cargo run
```

```text
counter.incrementRun refined 1 obligations
```

That project already passes. Now make it yours:

1. Edit `model.qnt`.
2. Run `npx quint-refinements compile`.
3. Run `cargo run`. The compiler lists each action hook `src/main.rs` still needs.

When the implementation disagrees with the model, you get the divergence:

```text
bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)
```

## Learn it step by step

The same pages are on the [documentation site](https://archastro.github.io/quint-refinements/), with search.

Each page builds a complete project that CI compiles and runs.

| | Page | You learn |
|---|---|---|
| 1 | [Tutorial: a bank account](docs/tutorial.md) | The whole loop: model, compile, implement, catch a bug |
| 2 | [A shop](docs/guides/shop-orders.md) | Named constants, `if`/`else` actions, a model in two files |
| 3 | [A transaction commit](docs/guides/one-command-many-actions.md) | `@primitive`, intermediate snapshots, binding constants to Rust |
| 4 | [CI](docs/guides/ci.md) | `compile --check`, generating into an existing crate |

Then: [how it works](docs/how-it-works.md) and [troubleshooting](docs/troubleshooting.md). Reference: [command line](docs/reference/cli.md), [model annotations and rules](docs/reference/model.md), [generated Rust](docs/reference/rust.md).

## What you write in the model

Two annotations. Everything else is ordinary Quint.

| Annotation | Where | Meaning |
|---|---|---|
| `/// @conformance` | above a `run` | Check the implementation against this scenario. |
| `/// @primitive commit = [prepare, flushWal, commitPrepared]` | in the module comment | One implementation command performs these actions, in this order. |

```quint
module bank {
  type BankState = { balance: int }

  var state: BankState

  action init = all {
    state' = { balance: 10 },
  }

  action withdraw(amount) = all {
    amount > 0,
    state.balance >= amount,
    state' = { balance: state.balance - amount },
  }

  /// @conformance
  run withdrawRun = init
    .then(withdraw(4))
    .then(all {
      assert(state.balance == 6),
      state' = state,
    })
}
```

Model conventions the compiler enforces, with a message that says how to fix each one:

1. The model keeps its state in one record variable named `state`.
2. A scenario is `init.then(action)...` and ends with `all { assert(...), state' = state }`.
3. All scenarios share one initializer.

Scenarios may import their model from other `.qnt` files, and Quint's own errors are reported with file, line and column.

## What you write in Rust

The generated trait has one method per action, plus two that describe your state:

```rust
impl Implementation for Bank {
    type Evidence = Snapshot;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> { /* ... */ }
    fn snapshot(&self) -> Snapshot { /* ... */ }

    fn withdraw(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [RuntimeValue::Int(amount)] = arguments else {
            return Err(format!("withdraw expects one integer: {arguments:?}"));
        };
        self.withdraw(*amount)
    }
}
```

A `@primitive` becomes one method that returns a snapshot after each action it owns:

```rust
fn commit(&mut self, actions: &[ResolvedAction]) -> Result<Vec<Snapshot>, String>;
```

Add or rename an action in the model, compile, and `cargo` tells you which method is missing. Nothing is registered by hand.

Named constants in the model, such as `pure val coffee = { id: "coffee", total: 30 }`, need no Rust at all: a scenario that calls `pay(coffee)` hands your method the record. Override `fixtures` only to bind a constant to a production value, so the two cannot drift.

## What gets checked

1. Every action in a scenario has an implementation command that owns it.
2. Each command returns exactly one snapshot per action it owns.
3. Every guard of every action holds on the snapshot before it.
4. Every `state' = ...` assignment matches the complete snapshot after it.
5. An action with no single assignment (`if`/`else`, `any`) leaves exactly the state Quint reached.
6. Constants you bind to Rust values match the model's.

Which scenarios your product must cover stays your decision; write them as `@conformance` runs.

## Keep generated files honest

Generated files are checked in and never edited. Add one line to CI:

```console
npx quint-refinements compile --check
```

It fails when `quint-refinements.json` or `src/generated_refinement.rs` no longer matches the model.

## Command reference

```text
quint-refinements new <project-name> [--no-install]
quint-refinements compile [spec.qnt] [--check] [--module <name>]
                          [--artifact <path>] [--rust <path>]
```

`compile` defaults to `model.qnt`. `--artifact` and `--rust` place the generated files in an existing crate layout; with them the command does not scaffold `src/main.rs`.

## Examples

| Example | Shows | Run |
|---|---|---|
| [`bank_account`](examples/rust/bank_account) | The tutorial's finished project | `cargo run --manifest-path examples/rust/bank_account/Cargo.toml` |
| [`shop_orders`](examples/rust/shop_orders) | Constants, a branching action, model and scenarios in separate files | `cargo run --manifest-path examples/rust/shop_orders/Cargo.toml` |
| [`transaction_commit`](examples/rust/transaction_commit) | `@primitive` and a constant bound to Rust, as a standalone project | `cargo run --manifest-path examples/rust/transaction_commit/Cargo.toml` |
| [`two_phase_commit`](bindings/rust/examples/two_phase_commit) | `@primitive`: one `commit()` owning three actions, plus fixtures | `cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit` |
| `two_phase_commit_async` | The same generated adapter through the async driver | `cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit_async` |

The [examples guide](examples/README.md) lists the smaller runtime examples in learning order.

## Repository layout

```text
packages/compiler/   the npx CLI: Quint AST in, artifact and Rust adapter out
bindings/rust/       the Rust runtime, published to crates.io
examples/rust/       complete generated projects
conformance/         artifact schema and golden cases every binding must pass
docs/                guides and reference, as Markdown
website/             the documentation site built from docs/
```

The compiler and the Rust runtime release together under one version. Other language runtimes belong under `bindings/<language>` and read the same artifact.

## Beyond the generated adapter

The generated module exposes `OWNERSHIP`, `RETRIEVE`, `artifact()` and `Driver`, so you can drive scenarios yourself with `refine_scenario`, `refine_scenario_async` or a step-by-step `RefinementSession`. The lower-level JavaScript generator is exported as `quint-refinements/generate.mjs` for integrations that need custom capability names or partial refinement. See the [crate documentation](https://docs.rs/quint-refinements).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is licensed under the MIT License.
