use std::collections::BTreeMap;

use quint_refinements::{
    ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence, OwnershipTable, PrimitiveDriver,
    ResolvedAction, RuntimeValue, collect_ownership_records, quint_ownership, refine_scenario,
};

const TRACES: &str = include_str!("../traces.json");

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

#[derive(Debug)]
struct Bank {
    balance: i64,
}

impl Bank {
    fn new(balance: i64) -> Self {
        Self { balance }
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            balance: self.balance,
        }
    }

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
            return Err(format!(
                "withdraw expects one Quint action; got {actions:?}"
            ));
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

fn refine_withdraw_run() -> Result<(usize, i64), String> {
    let artifact = ConformanceArtifact::parse(TRACES).map_err(|error| error.to_string())?;
    let scenario = artifact
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "withdrawRun")
        .ok_or_else(|| "withdrawRun missing from traces.json".to_owned())?;
    let ownership = collect_ownership_records(&[OWNERSHIP]).map_err(|error| error.to_string())?;
    let fixtures = FixtureTable::new("bank");
    fixtures
        .validate(&artifact)
        .map_err(|error| error.to_string())?;

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
        // Boundary: the refinement scheduler maps `withdraw` to `Bank::withdraw`.
        let report = refine_withdraw_run().expect("the Rust bank refines Quint withdrawRun");

        // Observable outcome: every obligation passed and the real balance changed.
        assert_eq!(report, (3, 6));
    }
}
