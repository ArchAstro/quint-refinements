# Tutorial: check a Rust bank against Quint

This tutorial continues the bank example from Quint's [Getting Started guide](https://quint.sh/docs/getting-started). That guide finds an overdraft bug in the model, fixes the withdrawal guard, and verifies the model. Here we use the same progression to find the equivalent bug in Rust:

1. Install the tools.
2. Write the verified withdrawal specification.
3. Generate a refinement scenario.
4. Connect the scenario to Rust.
5. Find an implementation violation.
6. Fix the implementation.
7. Verify the result in a repeatable test.

The completed, runnable project is in [`examples/bank_account`](../examples/bank_account).

```text
Quint withdraw(4) expects balance 10 -> 6
             |
             v
       generated trace
             |
             v
      Rust Bank::withdraw(4)
             |
             v
       observed snapshot
             |
             v
       guard and next-state checks
```

## 1. Install the tools

You need Node.js 22 or newer and Rust 1.85 or newer. Create a project:

```console
cargo new bank-refinement-tutorial
cd bank-refinement-tutorial
```

Replace `Cargo.toml` with:

```toml
[package]
name = "bank-refinement-tutorial"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
quint-refinements = { git = "https://github.com/ArchAstro/quint-refinements" }
```

Create `package.json`:

```json
{
  "name": "bank-refinement-tutorial",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "node generate-traces.mjs",
    "check": "node generate-traces.mjs --check"
  },
  "dependencies": {
    "@archastro/quint-refinements": "github:ArchAstro/quint-refinements",
    "@informalsystems/quint": "0.32.0"
  },
  "overrides": {
    "adm-zip": "0.6.0"
  }
}
```

Install the JavaScript dependencies:

```console
npm install
```

The completed in-repository example uses local `path` and `file` dependencies instead of Git dependencies. This lets its tests exercise the current checkout.

## 2. Write the specification

Create `bank.qnt`:

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

The `@conformance` directive gives this scenario a stable capability name. `withdrawRun` starts with 10, withdraws 4, and requires the next state to contain 6.

## 3. Generate the refinement scenario

The generator needs the model entry points and the runtime values that Rust can expose. Create `app-config.mjs`:

```javascript
import {
  createItfActionNextHook,
  defineConformanceApp,
} from "@archastro/quint-refinements/harness/generate.mjs";

const retrieve = new Set([
  "name:state",
  "operator:assign",
  "operator:eq",
  "operator:field",
  "operator:igt",
  "operator:igte",
  "operator:isub",
  "path:state.balance",
]);

export const bankApp = defineConformanceApp({
  actions: ["withdraw"],
  capabilities: ["bank.withdraw"],
  expressionOperators: ["eq", "field"],
  expressionNames: ["state"],
  modelOnlyNames: [],
  modelOnlyOperators: [],
  initializers: ["init"],
  fixtureImports: [],
  requireObserve: true,
  attachActionNext: createItfActionNextHook(),
  runtimeObservationDependencyDigest:
    "sha256:54f2836ccff5e30c0e7a95fc7b7c711d1c4e567d4dd05074d6aa31776ed268cc",
  retrieveForCapabilities: () => new Set(retrieve),
  actionRetrieveForCapabilities: () => new Set(retrieve),
  sources: () => [{
    source: "bank.qnt",
    module: "bank",
    init: "init",
    step: "withdraw",
  }],
});
```

The dependency digest is intentional. If a model edit changes what the adapter must expose, generation stops and prints the new digest for review.

Create `generate-traces.mjs`:

```javascript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateConformanceTraces } from "@archastro/quint-refinements/harness/generate.mjs";
import { bankApp } from "./app-config.mjs";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(projectDir, "traces.json");
const check = process.argv.slice(2).includes("--check");

const traces = generateConformanceTraces({
  root: projectDir,
  specDir: projectDir,
  app: bankApp,
  fullyRefinedRuns: new Set(["bank.withdrawRun"]),
});
const generated = `${JSON.stringify(traces, null, 2)}\n`;

if (check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== generated) {
    throw new Error("bank traces drifted; run npm run generate");
  }
  console.log("bank traces match the Quint model");
} else {
  fs.writeFileSync(outputPath, generated);
  console.log("wrote traces.json");
}
```

Generate the checked-in artifact:

```console
npm run generate
```

`traces.json` now contains the concrete `withdraw(4)` action, its two guards, its complete next-state assignment, and the initial Quint state.

## 4. Connect the scenario to Rust

The completed [`src/main.rs`](../examples/bank_account/src/main.rs) contains four pieces. Add them to your `src/main.rs` in this order. Start with the imports, generated artifact, and reviewed expression registry:

```rust
use std::collections::BTreeMap;

use quint_refinements::{
    ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence, OwnershipTable,
    PrimitiveDriver, ResolvedAction, RuntimeValue, collect_ownership_records, quint_ownership,
    refine_scenario,
};

const TRACES: &str = include_str!("../traces.json");

const RETRIEVE: &[&str] = &[
    "name:state",
    "operator:assign",
    "operator:eq",
    "operator:field",
    "operator:igt",
    "operator:igte",
    "operator:isub",
    "path:state.balance",
];
```

### 4.1 Record action ownership

An ownership record maps a stable implementation command to one or more ordered Quint actions:

```rust
quint_ownership! {
    const WITHDRAW = {
        primitive: "bank.withdraw",
        refines: ["withdraw"],
        aliases: [],
        observations: ["path:state.balance"],
        retrieve: ["name:state"],
    };
}

const OWNERSHIP: OwnershipTable = OwnershipTable {
    owner: "bank-refinement-tutorial",
    descriptors: &[WITHDRAW],
};
```

The scheduler fails if a generated action has no owner or has multiple owners.

### 4.2 Expose an observable snapshot

The evaluator reads named Quint values from implementation snapshots:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
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
```

This adapter exposes the complete model state as `state`. The evaluator compares it structurally; it does not serialize and compare debug strings.

### 4.3 Drive the real command

Start with an intentionally incorrect implementation:

```rust
#[derive(Debug)]
struct Bank {
    balance: i64,
}

impl Bank {
    fn new(balance: i64) -> Self {
        Self { balance }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot { balance: self.balance }
    }

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
```

`PrimitiveDriver` receives the argument generated from Quint, invokes the real command once, and returns one snapshot for the owned action:

```rust
impl PrimitiveDriver for Bank {
    type Evidence = Snapshot;

    fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String> {
        if primitive != "bank.withdraw" {
            return Err(format!("unknown primitive {primitive}"));
        }
        let [action] = actions else {
            return Err(format!("withdraw expects one Quint action; got {actions:?}"));
        };
        if action.name != "withdraw" {
            return Err(format!("withdraw primitive cannot refine {}", action.name));
        }
        let [RuntimeValue::Int(amount)] = action.arguments.as_slice() else {
            return Err(format!("withdraw expects one integer argument: {action:?}"));
        };

        self.withdraw(*amount)?;
        Ok(vec![self.snapshot()])
    }
}
```

### 4.4 Run the refinement loop

Parse the artifact, select the scenario, validate ownership, and run it:

```rust
fn refine_withdraw_run() -> Result<(usize, i64), String> {
    let artifact = ConformanceArtifact::parse(TRACES).map_err(|error| error.to_string())?;
    let scenario = artifact
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "withdrawRun")
        .ok_or_else(|| "withdrawRun missing from traces.json".to_owned())?;
    let ownership = collect_ownership_records(&[OWNERSHIP]).map_err(|error| error.to_string())?;
    let fixtures = FixtureTable::new("bank");
    fixtures.validate(&artifact).map_err(|error| error.to_string())?;
    let mut bank = Bank::new(10);

    let evaluated_obligations = refine_scenario(
        scenario,
        bank.snapshot(),
        &ownership,
        RETRIEVE,
        &fixtures,
        &mut bank,
    )?;

    Ok((evaluated_obligations, bank.balance))
}

fn main() {
    match refine_withdraw_run() {
        Ok((evaluated_obligations, final_balance)) => println!(
            "bank refinement passed: {} obligations, final balance {}",
            evaluated_obligations, final_balance
        ),
        Err(error) => {
            eprintln!("bank refinement failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::refine_withdraw_run;

    #[test]
    fn generated_quint_withdrawal_drives_the_real_bank_and_checks_its_snapshot() {
        // Setup: traces.json contains the scenario generated from bank.qnt.
        // Boundary: the scheduler maps `withdraw` to `Bank::withdraw`.
        let report = refine_withdraw_run().expect("the Rust bank refines Quint withdrawRun");

        // Outcome: all obligations passed and the real balance changed.
        assert_eq!(report, (3, 6));
    }
}
```

The `RETRIEVE` registry is the Rust-side allowlist for the generated expressions.

## 5. Find the implementation violation

Run the buggy implementation:

```console
cargo run
```

The refinement fails at the exact field that diverged:

```text
bank refinement failed: bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)
```

The two guards passed: the amount was positive and the account had enough money. The command then returned a state that violated Quint's next-state assignment.

## 6. Fix the issue

Change the command to subtract the withdrawal:

```rust
self.balance -= amount;
```

Run it again:

```console
cargo run
```

The result is:

```text
bank refinement passed: 3 obligations, final balance 6
```

## 7. Verify the result

Check that the committed trace still matches the model, then run the end-to-end Rust test:

```console
npm run check
cargo test
```

The canonical test is `generated_quint_withdrawal_drives_the_real_bank_and_checks_its_snapshot` in [`src/main.rs`](../examples/bank_account/src/main.rs). It crosses these boundaries:

1. Reads the checked-in scenario generated by the real Quint CLI.
2. Resolves `withdraw` through the ownership scheduler.
3. Passes Quint's generated amount to the real Rust command.
4. Evaluates the generated guards and next-state assignment against the returned snapshot.
5. Asserts the externally visible final balance is 6.

For CI, run both commands whenever the model, generator configuration, ownership records, implementation command, or evidence adapter changes.

## Copy the completed project

From a clone of this repository:

```console
cp -R examples/bank_account examples/my-bank-refinement
cd examples/my-bank-refinement
npm install
npm run check
cargo test
cargo run
```

The copied `Cargo.toml` and `package.json` use paths back to the repository root. Replace those two local dependencies with the Git dependencies from step 1 if you move the project outside this repository.
