# Guide: constants, branching actions and a model in two files

The [bank tutorial](../tutorial.md) checks one action with a literal argument. Real models pass named values around, branch, and outgrow one file. This guide builds a small shop that does all three.

The finished project is [`examples/rust/shop_orders`](../../examples/rust/shop_orders).

| Step | You learn |
|---|---|
| 1 to 3 | Keeping the model in one file and its scenarios in another |
| 4 | How named constants such as `coffee` reach your Rust code |
| 5 to 6 | Checking an `if`/`else` action, and reading the failure when it is wrong |

## 1. Create the project

```console
npx quint-refinements new shop-check
cd shop-check
```

## 2. Write the model in its own file

Create `shop.qnt`. It holds the types, the constants, the state and one action:

```quint
/// A shop that takes payment for orders and refunds them.
module shop {
  type Order = { id: str, total: int }
  type State = { paid: Set[str], revenue: int }

  pure val coffee: Order = { id: "coffee", total: 30 }
  pure val bagel: Order = { id: "bagel", total: 12 }

  var state: State

  action init = all {
    state' = { paid: Set(), revenue: 0 },
  }

  action pay(order: Order): bool = all {
    not(state.paid.contains(order.id)),
    state' = {
      paid: state.paid.union(Set(order.id)),
      revenue: state.revenue + order.total,
    },
  }
}
```

`coffee` and `bagel` are named constants. The model keeps all of its state in one record variable named `state`.

## 3. Write the scenarios in `model.qnt`

Replace `model.qnt` with a module that imports the shop and describes one scenario:

```quint
module scenarios {
  import shop.* from "./shop"

  /// @conformance
  run payBothRun = init
    .then(pay(coffee))
    .then(pay(bagel))
    .then(all {
      assert(state.revenue == 42),
      state' = state,
    })
}
```

Compile it. `compile` reads `model.qnt` by default and follows the import:

```console
npx quint-refinements compile
cargo run
```

The starter `src/main.rs` still implements the counter, so the build names what the new model needs:

```text
error[E0407]: method `increment` is not a member of trait `Implementation`
error[E0046]: not all trait items implemented, missing: `pay`
```

## 4. Implement `pay` and receive a constant

Replace `src/main.rs`. First the code under test and the snapshot the checker observes:

<!-- from examples/rust/shop_orders/src/main.rs -->
```rust
mod generated_refinement;

use std::collections::{BTreeMap, BTreeSet};

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

/// The code under test.
#[derive(Default)]
struct Shop {
    paid: BTreeSet<String>,
    revenue: i64,
}

impl Shop {
    fn pay(&mut self, id: &str, total: i64) -> Result<(), String> {
        if !self.paid.insert(id.to_owned()) {
            return Err(format!("order {id} is already paid"));
        }
        self.revenue += total;
        Ok(())
    }

    fn refund(&mut self, id: &str, total: i64) {
        if self.paid.remove(id) {
            self.revenue -= total;
        }
    }
}

/// What the checker may observe: the model's `state` record.
#[derive(Clone)]
struct Snapshot {
    paid: BTreeSet<String>,
    revenue: i64,
}

impl NormalizedRuntimeEvidence for Snapshot {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Record(BTreeMap::from([
                (
                    "paid".to_owned(),
                    RuntimeValue::Set(self.paid.iter().cloned().map(RuntimeValue::Text).collect()),
                ),
                ("revenue".to_owned(), RuntimeValue::Int(self.revenue)),
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

`Shop::refund` is included now so the file is complete. Rust warns that it is unused until step 5 adds it to the model.

Now the constant. The scenario calls `pay(coffee)`. You do not declare `coffee` anywhere in Rust: the generated adapter takes its value from the model and hands your hook the record itself.

<!-- from examples/rust/shop_orders/src/main.rs -->
```rust
/// Reads the `Order` record the model passes to `pay` and `refund`.
fn order(arguments: &[RuntimeValue]) -> Result<(&str, i64), String> {
    let [RuntimeValue::Record(order)] = arguments else {
        return Err(format!("expected one order record: {arguments:?}"));
    };
    match (order.get("id"), order.get("total")) {
        (Some(RuntimeValue::Text(id)), Some(RuntimeValue::Int(total))) => Ok((id, *total)),
        _ => Err(format!(
            "order needs a text id and an integer total: {order:?}"
        )),
    }
}
```

Connect the hook and run the scenarios:

```rust
impl Implementation for Shop {
    type Evidence = Snapshot;

    fn from_initial_state(_initial_state: &RuntimeValue) -> Result<Self, String> {
        Ok(Self::default())
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            paid: self.paid.clone(),
            revenue: self.revenue,
        }
    }

    fn pay(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let (id, total) = order(arguments)?;
        self.pay(id, total)
    }
}
```

<!-- from examples/rust/shop_orders/src/main.rs -->
```rust
fn main() {
    match refine_all::<Shop>() {
        Ok(results) => {
            for result in results {
                println!(
                    "{} refined {} obligations",
                    result.scenario, result.evaluated_obligations
                );
            }
        }
        Err(error) => {
            eprintln!("refinement failed: {error}");
            std::process::exit(1);
        }
    }
}
```

```console
cargo run
```

```text
scenarios.payBothRun refined 4 obligations
```

Four obligations: for each `pay`, its guard (`not(state.paid.contains(order.id))`) held before the call, and the complete `state` after the call equals what the model's assignment computes.

## 5. Add an action that branches

Refunding an order that was never paid must change nothing. Add `refund` to `shop.qnt`:

<!-- from examples/rust/shop_orders/shop.qnt -->
```quint
  /// Refunding an unpaid order changes nothing.
  action refund(order: Order): bool =
    if (state.paid.contains(order.id)) {
      state' = {
        paid: state.paid.exclude(Set(order.id)),
        revenue: state.revenue - order.total,
      }
    } else {
      state' = state
    }
```

Add a scenario to `model.qnt` that refunds a paid order and then an unpaid one:

<!-- from examples/rust/shop_orders/model.qnt -->
```quint
  /// @conformance
  run refundRun = init
    .then(pay(coffee))
    .then(refund(coffee))
    .then(refund(bagel))
    .then(all {
      assert(all {
        state.revenue == 0,
        state.paid.size() == 0,
      }),
      state' = state,
    })
```

The assertion uses `all { ... }` to require both conditions.

```console
npx quint-refinements compile
cargo run
```

```text
error[E0046]: not all trait items implemented, missing: `refund`
```

To see a failure first, change `Shop::refund` to this buggy version, which subtracts the total whether or not the order was paid:

```rust
    fn refund(&mut self, id: &str, total: i64) {
        self.paid.remove(id);
        self.revenue -= total; // BUG: also refunds orders that were never paid
    }
```

Then add the generated hook to `impl Implementation for Shop`:

<!-- from examples/rust/shop_orders/src/main.rs -->
```rust
    fn refund(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let (id, total) = order(arguments)?;
        self.refund(id, total);
        Ok(())
    }
```

## 6. Read the failure, fix it

```console
cargo run
```

```text
refinement failed: scenarios.refundRun:refund post-guard: assign state diverged at state.revenue expected Int(0), observed Int(-12)
```

Read it left to right:

1. `scenarios.refundRun`: the scenario.
2. `refund`: the action that diverged. It is the second refund, of the unpaid `bagel` (total 12).
3. `state.revenue expected Int(0), observed Int(-12)`: the model says revenue stays 0; the code produced -12.

An `if`/`else` action has no single `state' = ...` line to compare against. The compiler checks both the branch the model took and the exact state Quint reached after the action, so branching actions are held to the same standard as simple ones.

Fix the command:

<!-- from examples/rust/shop_orders/src/main.rs -->
```rust
    fn refund(&mut self, id: &str, total: i64) {
        if self.paid.remove(id) {
            self.revenue -= total;
        }
    }
```

```console
cargo run
```

```text
scenarios.payBothRun refined 4 obligations
scenarios.refundRun refined 6 obligations
```

## What you did not write

1. No list of actions, constants or files. `compile` found `shop.qnt` through the import.
2. No Rust declaration for `coffee` or `bagel`.
3. No per-scenario test code. Adding `refundRun` to the model was the whole test.

Next: [one command, several actions](one-command-many-actions.md), or [keep generated files honest in CI](ci.md).
