#![allow(clippy::expect_used)]

use std::future::Future;

use futures::executor::block_on;
use quint_refinements::{
    AsyncPrimitiveDriver, ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence,
    OwnershipDescriptor, RuntimeValue, refine_scenario_async,
};

const SCENARIO: &str = r#"{
  "schemaVersion": 2,
  "modelDigest": "sha256:async-driver-test",
  "vocabulary": {
    "actions": ["prepare", "commit"],
    "capabilities": ["txn.commit"],
    "expressionOperators": [],
    "expressionNames": [],
    "runtimeObservationDependencies": [],
    "runtimeObservationDependencyDigest": "sha256:test"
  },
  "fixtures": { "async_driver": {} },
  "scenarios": [{
    "source": "async_driver.qnt",
    "module": "async_driver",
    "fixtureNamespace": "async_driver",
    "name": "commitRun",
    "requiredCapabilities": ["txn.commit"],
    "steps": [
      { "index": 0, "kind": "init", "action": "init", "arguments": [] },
      {
        "index": 1,
        "kind": "action",
        "action": "prepare",
        "arguments": [],
        "next": [{
          "scope": "runtime",
          "expression": {
            "kind": "call",
            "operator": "eq",
            "arguments": [
              { "kind": "name", "value": "state" },
              { "kind": "int", "value": 1 }
            ]
          }
        }]
      },
      {
        "index": 2,
        "kind": "action",
        "action": "commit",
        "arguments": [],
        "next": [{
          "scope": "runtime",
          "expression": {
            "kind": "call",
            "operator": "eq",
            "arguments": [
              { "kind": "name", "value": "state" },
              { "kind": "int", "value": 2 }
            ]
          }
        }]
      }
    ]
  }]
}"#;

#[derive(Clone)]
struct Evidence(i64);

impl NormalizedRuntimeEvidence for Evidence {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Int(self.0)),
            _ => Err(format!("unknown evidence name {name}")),
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

struct Driver {
    calls: usize,
    short: bool,
}

impl AsyncPrimitiveDriver for Driver {
    type Evidence = Evidence;

    async fn run_primitive(
        &mut self,
        primitive: &str,
        owned_actions: &[String],
    ) -> Result<Vec<Self::Evidence>, String> {
        self.calls += 1;
        if primitive != "database.commit" || owned_actions != ["prepare", "commit"] {
            return Err(format!(
                "unexpected async primitive tape {primitive} {owned_actions:?}"
            ));
        }
        Ok(if self.short {
            vec![Evidence(1)]
        } else {
            vec![Evidence(1), Evidence(2)]
        })
    }
}

fn ownership() -> [OwnershipDescriptor; 1] {
    [OwnershipDescriptor {
        owner: "async-driver-test".to_owned(),
        primitive: "database.commit".to_owned(),
        refines: vec!["prepare".to_owned(), "commit".to_owned()],
        aliases: Vec::new(),
        actions: vec!["prepare".to_owned(), "commit".to_owned()],
        observations: Vec::new(),
        retrieve: Vec::new(),
    }]
}

fn refinement<'a>(
    artifact: &'a ConformanceArtifact,
    ownership: &'a [OwnershipDescriptor],
    fixtures: &'a FixtureTable,
    driver: &'a mut Driver,
) -> impl Future<Output = Result<usize, String>> + Send + 'a {
    refine_scenario_async(
        &artifact.scenarios[0],
        Evidence(0),
        ownership,
        &["name:state"],
        fixtures,
        driver,
    )
}

#[test]
fn async_driver_runs_one_primitive_for_compound_refinement_tape() {
    let artifact = ConformanceArtifact::parse(SCENARIO).expect("parse async scenario");
    let ownership = ownership();
    let fixtures = FixtureTable::new("async_driver");
    let mut driver = Driver {
        calls: 0,
        short: false,
    };

    let evaluated = block_on(refinement(&artifact, &ownership, &fixtures, &mut driver))
        .expect("async compound tape refines");

    assert_eq!(evaluated, 2);
    assert_eq!(driver.calls, 1);
}

#[test]
fn async_driver_rejects_short_compound_evidence_tape() {
    let artifact = ConformanceArtifact::parse(SCENARIO).expect("parse async scenario");
    let ownership = ownership();
    let fixtures = FixtureTable::new("async_driver");
    let mut driver = Driver {
        calls: 0,
        short: true,
    };

    let error = block_on(refinement(&artifact, &ownership, &fixtures, &mut driver))
        .expect_err("short async tape must fail");

    assert!(error.contains("owns 2 actions but returned 1"), "{error}");
    assert_eq!(driver.calls, 1);
}

#[test]
fn async_refinement_future_is_send() {
    fn assert_send<T: Send>(_value: T) {}

    let artifact = ConformanceArtifact::parse(SCENARIO).expect("parse async scenario");
    let ownership = ownership();
    let fixtures = FixtureTable::new("async_driver");
    let mut driver = Driver {
        calls: 0,
        short: false,
    };

    assert_send(refinement(&artifact, &ownership, &fixtures, &mut driver));
}
