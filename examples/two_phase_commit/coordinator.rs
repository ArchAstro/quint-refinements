//! Client `commit()` is one Rust function. Quint still has prepare, flush, commit.

use std::collections::BTreeMap;

use quint_refinements::{
    ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence, OwnershipTable, PrimitiveDriver,
    QuintFixture, RuntimeValue, collect_ownership_records, quint_ownership, refine_scenario,
};

quint_ownership! {
    pub const BEGIN_OWNERSHIP = {
        primitive: "postgres.txn.begin",
        refines: ["begin"],
        observations: ["path:state.status"],
    };
}

quint_ownership! {
    pub const COMMIT_OWNERSHIP = {
        primitive: "postgres.txn.commit",
        refines: ["prepare", "flushWal", "commitPrepared"],
        observations: ["path:state.status", "path:state.flushed", "path:state.wal_len"],
    };
}

pub const OWNERSHIP: OwnershipTable = OwnershipTable {
    owner: "two-phase-commit-example",
    descriptors: &[BEGIN_OWNERSHIP, COMMIT_OWNERSHIP],
};

const RETRIEVE: &[&str] = &[
    "name:state",
    "operator:contains",
    "operator:eq",
    "operator:field",
    "path:state.flushed",
    "path:state.status",
    "path:state.wal_len",
];

const TRACES: &str = include_str!("traces.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Idle,
    Open,
    Prepared,
    Committed,
    Aborted,
}

impl Status {
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
        serde_json::Value::String(self.as_str().to_owned())
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Text(self.as_str().to_owned())
    }
}

/// Quint `Idle`/`statuses` are this enum, not a parallel test twin.
pub fn fixture_table() -> FixtureTable {
    FixtureTable::new("two_phase_commit")
        .insert("Aborted", &Status::Aborted)
        .insert("Committed", &Status::Committed)
        .insert("Idle", &Status::Idle)
        .insert("Open", &Status::Open)
        .insert("Prepared", &Status::Prepared)
        .insert_set(
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
                    "wal_len".to_owned(),
                    RuntimeValue::Int(self.wal.len() as i64),
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

impl PrimitiveDriver for Coordinator {
    type Evidence = Snapshot;

    fn run_primitive(
        &mut self,
        primitive: &str,
        owned_actions: &[String],
    ) -> Result<Vec<Snapshot>, String> {
        match primitive {
            "postgres.txn.begin" => {
                self.begin()?;
                Ok(vec![self.snapshot.clone()])
            }
            "postgres.txn.commit" => {
                if owned_actions
                    != [
                        "prepare".to_owned(),
                        "flushWal".to_owned(),
                        "commitPrepared".to_owned(),
                    ]
                {
                    return Err(format!(
                        "commit tape must be prepare, flushWal, commitPrepared; got {owned_actions:?}"
                    ));
                }
                self.commit()
            }
            other => Err(format!("no driver for {other}")),
        }
    }
}

/// Runs `commitRun` through the refinement loop.
pub fn refine_commit_run() -> Result<usize, String> {
    let artifact = ConformanceArtifact::parse(TRACES).map_err(|error| error.to_string())?;
    let scenario = artifact
        .scenarios
        .first()
        .ok_or_else(|| "commitRun missing".to_owned())?;
    let ownership = collect_ownership_records(&[OWNERSHIP]).map_err(|error| error.to_string())?;
    let fixtures = fixture_table();
    fixtures
        .validate(&artifact)
        .map_err(|error| error.to_string())?;
    let mut driver = Coordinator::new();
    refine_scenario(
        scenario,
        driver.snapshot(),
        &ownership,
        RETRIEVE,
        &fixtures,
        &mut driver,
    )
}
