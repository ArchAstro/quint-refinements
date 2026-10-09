//! Client `commit()` is one Rust function. Quint still has prepare, flush, commit.
//!
//! Everything that connects this file to `model.qnt` lives in `generated.rs`,
//! which `quint-refinements compile` derives from the model.

use std::collections::BTreeMap;

use quint_refinements::{
    FixtureTable, NormalizedRuntimeEvidence, QuintFixture, ResolvedAction, RuntimeValue,
    collect_ownership_records, refine_scenario_async,
};

#[path = "generated.rs"]
pub mod generated;

use generated::{Driver, Implementation, OWNERSHIP, RETRIEVE, refine_all};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Idle,
    Open,
    Prepared,
    Committed,
    Aborted,
}

impl Status {
    fn from_tag(tag: &str) -> Result<Self, String> {
        match tag {
            "Idle" => Ok(Self::Idle),
            "Open" => Ok(Self::Open),
            "Prepared" => Ok(Self::Prepared),
            "Committed" => Ok(Self::Committed),
            "Aborted" => Ok(Self::Aborted),
            other => Err(format!("unknown status {other}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Open => "Open",
            Self::Prepared => "Prepared",
            Self::Committed => "Committed",
            Self::Aborted => "Aborted",
        }
    }
}

impl QuintFixture for Status {
    fn artifact_json(&self) -> serde_json::Value {
        serde_json::json!({
            "tag": self.as_str(),
            "value": { "#tup": [] },
        })
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Text(self.as_str().to_owned())
    }
}

/// Quint `Idle`/`statuses` are this enum, not a parallel test twin.
pub fn fixture_table() -> FixtureTable {
    FixtureTable::new("two_phase_commit").insert_set(
        "statuses",
        &[
            Status::Aborted,
            Status::Committed,
            Status::Idle,
            Status::Open,
            Status::Prepared,
        ],
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub status: Status,
    pub wal: Vec<String>,
    pub flushed: bool,
}

impl NormalizedRuntimeEvidence for Snapshot {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Record(BTreeMap::from([
                (
                    "status".to_owned(),
                    RuntimeValue::Text(self.status.as_str().to_owned()),
                ),
                ("flushed".to_owned(), RuntimeValue::Bool(self.flushed)),
                (
                    "wal".to_owned(),
                    RuntimeValue::List(self.wal.iter().cloned().map(RuntimeValue::Text).collect()),
                ),
            ]))),
            _ => Err(format!("unknown name {name}")),
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

/// In-memory stand-in for a Postgres transaction's prepare/flush/commit log.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Coordinator {
    snapshot: Snapshot,
}

impl Coordinator {
    #[must_use]
    pub fn new() -> Self {
        Self {
            snapshot: Snapshot {
                status: Status::Idle,
                wal: Vec::new(),
                flushed: false,
            },
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }

    fn begin(&mut self) -> Result<(), String> {
        if self.snapshot.status != Status::Idle {
            return Err("begin requires Idle".to_owned());
        }
        self.snapshot.status = Status::Open;
        Ok(())
    }

    fn prepare(&mut self) -> Result<(), String> {
        if self.snapshot.status != Status::Open {
            return Err("prepare requires Open".to_owned());
        }
        self.snapshot.status = Status::Prepared;
        self.snapshot.wal.push("prepare".to_owned());
        self.snapshot.flushed = false;
        Ok(())
    }

    fn flush_wal(&mut self) -> Result<(), String> {
        if self.snapshot.status != Status::Prepared || self.snapshot.flushed {
            return Err("flush requires unflushed Prepared".to_owned());
        }
        self.snapshot.flushed = true;
        Ok(())
    }

    fn commit_prepared(&mut self) -> Result<(), String> {
        if self.snapshot.status != Status::Prepared || !self.snapshot.flushed {
            return Err("commitPrepared requires flushed Prepared".to_owned());
        }
        self.snapshot.status = Status::Committed;
        self.snapshot.wal.push("commit".to_owned());
        Ok(())
    }

    fn abort(&mut self) -> Result<(), String> {
        if !matches!(self.snapshot.status, Status::Open | Status::Prepared) {
            return Err("abort requires Open or Prepared".to_owned());
        }
        self.snapshot.status = Status::Aborted;
        Ok(())
    }

    /// One client COMMIT. Internally prepare, flush, commit — the 1-to-N tape.
    fn commit(&mut self) -> Result<Vec<Snapshot>, String> {
        self.prepare()?;
        let prepared = self.snapshot.clone();
        self.flush_wal()?;
        let flushed = self.snapshot.clone();
        self.commit_prepared()?;
        Ok(vec![prepared, flushed, self.snapshot.clone()])
    }
}

impl Default for Coordinator {
    fn default() -> Self {
        Self::new()
    }
}

/// The generated trait: one hook per implementation command.
impl Implementation for Coordinator {
    type Evidence = Snapshot;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> {
        let RuntimeValue::Record(state) = initial_state else {
            return Err(format!(
                "expected a transaction record, got {initial_state:?}"
            ));
        };
        let status = match state.get("status") {
            Some(RuntimeValue::Text(tag) | RuntimeValue::Variant { tag, .. }) => {
                Status::from_tag(tag)?
            }
            other => return Err(format!("transaction has no status tag: {other:?}")),
        };
        let Some(RuntimeValue::List(wal)) = state.get("wal") else {
            return Err(format!("transaction has no wal list: {state:?}"));
        };
        let wal = wal
            .iter()
            .map(|entry| match entry {
                RuntimeValue::Text(entry) => Ok(entry.clone()),
                other => Err(format!("wal entry is not text: {other:?}")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let Some(RuntimeValue::Bool(flushed)) = state.get("flushed") else {
            return Err(format!("transaction has no flushed flag: {state:?}"));
        };
        Ok(Self {
            snapshot: Snapshot {
                status,
                wal,
                flushed: *flushed,
            },
        })
    }

    fn snapshot(&self) -> Snapshot {
        self.snapshot()
    }

    fn fixtures() -> FixtureTable {
        fixture_table()
    }

    fn begin(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.begin()
    }

    fn abort(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.abort()
    }

    /// `@primitive commit = [prepare, flushWal, commitPrepared]` in the model.
    fn commit(&mut self, _actions: &[ResolvedAction]) -> Result<Vec<Snapshot>, String> {
        self.commit()
    }
}

/// Runs every generated scenario and returns the obligations `commitRun` evaluated.
pub fn refine_commit_run() -> Result<usize, String> {
    refine_all::<Coordinator>()?
        .into_iter()
        .find(|result| result.scenario == "two_phase_commit.commitRun")
        .map(|result| result.evaluated_obligations)
        .ok_or_else(|| "commitRun missing".to_owned())
}

/// Runs generated `commitRun` through the runtime-neutral async driver API.
#[allow(dead_code)]
pub async fn refine_commit_run_async() -> Result<usize, String> {
    let artifact = generated::artifact()?;
    let scenario = artifact
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "commitRun")
        .ok_or_else(|| "commitRun missing".to_owned())?;
    let ownership = collect_ownership_records(&[OWNERSHIP]).map_err(|error| error.to_string())?;
    let fixtures = fixture_table();
    fixtures
        .validate(&artifact)
        .map_err(|error| error.to_string())?;
    let mut driver = Driver {
        implementation: Coordinator::new(),
    };
    refine_scenario_async(
        scenario,
        driver.implementation.snapshot(),
        &ownership,
        RETRIEVE,
        &fixtures,
        &mut driver,
    )
    .await
}
