mod generated_refinement;

use std::collections::BTreeMap;

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{
    ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence, QuintFixture, ResolvedAction,
    RuntimeValue,
};

/// Every status the production code can be in.
const STATUSES: [Status; 5] = [
    Status("Idle"),
    Status("Open"),
    Status("Prepared"),
    Status("Committed"),
    Status("Aborted"),
];

struct Status(&'static str);

impl QuintFixture for Status {
    fn artifact_json(&self) -> serde_json::Value {
        serde_json::json!({ "tag": self.0, "value": { "#tup": [] } })
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Text(self.0.to_owned())
    }
}

/// The code under test: a transaction with a write-ahead log.
#[derive(Clone)]
struct Transaction {
    status: &'static str,
    wal: Vec<String>,
    flushed: bool,
}

impl Transaction {
    fn begin(&mut self) {
        self.status = "Open";
    }

    fn abort(&mut self) {
        self.status = "Aborted";
    }

    /// One client COMMIT: write PREPARE, flush, write COMMIT.
    /// Returns the transaction as it stood after each of the three steps.
    fn commit(&mut self) -> Vec<Transaction> {
        self.status = "Prepared";
        self.wal.push("prepare".to_owned());
        let prepared = self.clone();

        self.flushed = true;
        let flushed = self.clone();

        self.status = "Committed";
        self.wal.push("commit".to_owned());
        vec![prepared, flushed, self.clone()]
    }
}

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

impl Implementation for Transaction {
    type Evidence = Transaction;

    fn from_initial_state(_initial_state: &RuntimeValue) -> Result<Self, String> {
        Ok(Self {
            status: "Idle",
            wal: Vec::new(),
            flushed: false,
        })
    }

    fn snapshot(&self) -> Transaction {
        self.clone()
    }

    fn fixtures(artifact: &ConformanceArtifact) -> Result<FixtureTable, String> {
        Ok(FixtureTable::from_artifact("two_phase_commit", artifact)
            .map_err(|error| error.to_string())?
            .insert_set("statuses", &STATUSES))
    }

    fn begin(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.begin();
        Ok(())
    }

    fn abort(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.abort();
        Ok(())
    }

    fn commit(&mut self, _actions: &[ResolvedAction]) -> Result<Vec<Transaction>, String> {
        Ok(self.commit())
    }
}

fn main() {
    match refine_all::<Transaction>() {
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

#[cfg(test)]
mod tests {
    use super::{Transaction, refine_all};

    #[test]
    fn transaction_refines_every_quint_scenario() {
        if let Err(error) = refine_all::<Transaction>() {
            panic!("refinement failed: {error}");
        }
    }
}
