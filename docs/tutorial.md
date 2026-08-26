# Tutorial: generate a Rust refinement project from Quint

This tutorial follows Quint's [Getting Started guide](https://quint.sh/docs/getting-started): create a project, write a bank specification, find a violation, fix it, and verify the result. The difference is the boundary being checked. Quint verifies the model; `quint-refinements` generates the code needed to check that Rust follows that model.

You will write two things:

1. The Quint specification.
2. The Rust bank implementation.

The trace configuration, ownership records, action dispatch, expression registry, and refinement runner are generated from Quint's own AST.

The completed project is in [`examples/rust/bank_account`](../examples/rust/bank_account).

```text
model.qnt
   |
   |  npx quint-refinements compile model.qnt
   v
Quint AST -> generated scenario + generated Rust adapter
                                      |
                                      v
                              your Bank implementation
                                      |
                                      v
                           guards and next state agree
```

## 1. Create the project

You need Node.js 22 or newer and Rust 1.85 or newer.

```console
npx quint-refinements new bank-refinement
cd bank-refinement
```

`new` creates the Cargo and npm manifests, installs the pinned Quint toolchain, and adds a starter `model.qnt`. It does not create generator configuration files.

## 2. Write the Quint specification

Replace `model.qnt` with:

```quint
/// One-account version of the bank from Quint's Getting Started tutorial.
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

  /// @conformance requires = [bank.withdraw]
  run withdrawRun = init
    .then(withdraw(4))
    .then(all {
      assert(state.balance == 6),
      state' = state,
    })
}
```

Get the Quint model working before connecting Rust. The `@conformance` directive marks `withdrawRun` for generated refinement coverage.

## 3. Compile the refinement boundary

Run:

```console
npx quint-refinements compile model.qnt
```

The command invokes the pinned `quint parse` and `quint compile` commands. It derives the integration from Quint's parsed declarations and expressions.

| Generated file | Contents |
|---|---|
| `quint-refinements.json` | Concrete run, initial state, action arguments, guards, and next-state assignments |
| `src/generated_refinement.rs` | Ownership records, action dispatch, expression registry, and refinement runner |
| `src/main.rs` | A first-run implementation scaffold with one hook per Quint action |

`src/generated_refinement.rs` is replaced every time you compile. `src/main.rs` is created only when it does not exist, so later compilation never overwrites your implementation.

For this model, the generated Rust trait asks for three domain decisions:

```rust
pub trait Implementation: Sized {
    type Evidence: NormalizedRuntimeEvidence + Clone;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String>;
    fn snapshot(&self) -> Self::Evidence;
    fn withdraw(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;
}
```

The action name, hook, arguments, ownership record, and runner came from `model.qnt`. You implement the command and expose its observable state.

The generated path maps each Quint action to the capability `<module>.<action>`. Use the lower-level generator API when one production primitive intentionally owns several Quint actions.

## 4. Connect the Rust implementation

Replace `src/main.rs` with the following. Start with an intentional bug in `Bank::withdraw`: it adds the amount instead of subtracting it.

```rust
mod generated_refinement;

use std::collections::BTreeMap;

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

#[derive(Clone)]
struct Snapshot {
    balance: i64,
}

impl NormalizedRuntimeEvidence for Snapshot {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Record(BTreeMap::from([(
                "balance".to_owned(),
                RuntimeValue::Int(self.balance),
            )]))),
            other => Err(format!("unknown evidence name {other}")),
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

struct Bank {
    balance: i64,
}

impl Bank {
    fn withdraw(&mut self, amount: i64) -> Result<(), String> {
        if amount <= 0 {
            return Err("withdrawal must be positive".to_owned());
        }
        if self.balance < amount {
            return Err("insufficient funds".to_owned());
        }
        self.balance += amount; // BUG: this should subtract
        Ok(())
    }
}

impl Implementation for Bank {
    type Evidence = Snapshot;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> {
        let RuntimeValue::Record(state) = initial_state else {
            return Err(format!("expected bank record, got {initial_state:?}"));
        };
        let Some(RuntimeValue::Int(balance)) = state.get("balance") else {
            return Err(format!("bank state has no integer balance: {state:?}"));
        };
        Ok(Self { balance: *balance })
    }

    fn snapshot(&self) -> Self::Evidence {
        Snapshot { balance: self.balance }
    }

    fn withdraw(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [RuntimeValue::Int(amount)] = arguments else {
            return Err(format!("withdraw expects one integer argument: {arguments:?}"));
        };
        self.withdraw(*amount)
    }
}

fn main() {
    match refine_all::<Bank>() {
        Ok(results) => {
            for result in results {
                println!(
                    "{} refined {} obligations; final balance {}",
                    result.scenario,
                    result.evaluated_obligations,
                    result.implementation.balance,
                );
            }
        }
        Err(error) => {
            eprintln!("bank refinement failed: {error}");
            std::process::exit(1);
        }
    }
}
```

## 5. Find the implementation violation

Run:

```console
cargo run
```

The generated adapter passes Quint's `4` to `Bank::withdraw`, snapshots the real bank, and evaluates the generated assignment:

```text
bank refinement failed: bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)
```

No handwritten JavaScript or action registry sits between the model and this failure.

## 6. Fix the issue

Change the command to subtract the amount:

```rust
self.balance -= amount;
```

Run it again:

```console
cargo run
```

The result is:

```text
bank.withdrawRun refined 3 obligations; final balance 6
```

## 7. Verify generated and handwritten code

Append this test to `src/main.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{Bank, refine_all};

    #[test]
    fn generated_quint_withdrawal_drives_the_real_bank_and_checks_its_snapshot() {
        // Setup: the compile command generated the scenario and Rust adapter.
        // Boundary: generated ownership passes `withdraw(4)` to the real Bank.
        let mut results = refine_all::<Bank>().expect("the Rust bank refines withdrawRun");
        let result = results.pop().expect("withdrawRun result");

        // Outcome: every generated guard and assignment passed against the real snapshot.
        assert_eq!(result.evaluated_obligations, 3);
        assert_eq!(result.implementation.balance, 6);
        assert!(results.is_empty(), "only withdrawRun should be generated");
    }
}
```

Then run:

```console
npx quint-refinements compile model.qnt --check
cargo test
```

The compile check fails if either generated file drifts from the Quint AST. The canonical test `generated_quint_withdrawal_drives_the_real_bank_and_checks_its_snapshot` crosses the generated ownership and driver boundary, invokes the real Rust withdrawal, evaluates all generated obligations, and asserts the final balance is 6.

The project now has one source of integration structure: `model.qnt`. Edit the model, compile again, and Rust compilation identifies any newly generated implementation hooks you still need to provide.
