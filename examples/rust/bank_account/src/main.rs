mod generated_refinement;

use std::collections::BTreeMap;

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

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

#[derive(Debug, Eq, PartialEq)]
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
        self.balance -= amount;
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
        Snapshot {
            balance: self.balance,
        }
    }

    fn withdraw(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [RuntimeValue::Int(amount)] = arguments else {
            return Err(format!(
                "withdraw expects one integer argument: {arguments:?}"
            ));
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
                    result.scenario, result.evaluated_obligations, result.implementation.balance,
                );
            }
        }
        Err(error) => {
            eprintln!("bank refinement failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Bank, refine_all};
    use serde_json::Value;

    const EXPECTED: &str =
        include_str!("../../../../conformance/cases/bank_withdraw/expected.json");

    #[test]
    fn generated_quint_withdrawal_drives_the_real_bank_and_checks_its_snapshot() {
        // Setup: the npx compile command generated the scenario and Rust adapter.
        // Boundary: generated ownership passes `withdraw(4)` to the real Bank.
        let mut results = refine_all::<Bank>().expect("the Rust bank refines withdrawRun");
        let result = results.pop().expect("withdrawRun result");
        let expected: Value = serde_json::from_str(EXPECTED).expect("valid shared expectation");

        // Outcome: all guards and the assignment match the shared binding corpus.
        assert_eq!(
            result.scenario,
            expected["scenario"].as_str().expect("scenario string")
        );
        assert_eq!(
            result.evaluated_obligations as u64,
            expected["evaluatedObligations"]
                .as_u64()
                .expect("obligation count")
        );
        assert_eq!(
            result.implementation.balance,
            expected["finalState"]["balance"]
                .as_i64()
                .expect("final balance")
        );
        assert!(results.is_empty(), "only withdrawRun should be generated");
    }
}
