#![allow(clippy::expect_used)]

use std::future::Future;

use futures::executor::block_on;
use quint_refinements::{
    AsyncActionDriver, AsyncPrimitiveDriver, ConformanceArtifact, FixtureTable,
    NormalizedRuntimeEvidence, OwnershipDescriptor, ResolvedAction, RuntimeValue,
    evaluate_projected_action_steps, refine_scenario_async, run_refined_actions_async,
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
        "arguments": [{"kind": "int", "value": 1}],
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
        "arguments": [{"kind": "int", "value": 2}],
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

const COMPLETE_SCENARIO: &str = r#"{
  "schemaVersion": 2,
  "modelDigest": "sha256:projected-state-test",
  "vocabulary": {
    "actions": ["advance"],
    "capabilities": ["state.advance"],
    "expressionOperators": ["assign", "eq", "field", "with"],
    "expressionNames": ["state"],
    "refinementExpressionOperators": ["List", "Map", "Present", "Rec", "Set", "Tup", "actionAll", "actionAny", "and", "append", "assign", "concat", "contains", "eq", "exclude", "exists", "field", "filter", "fold", "forall", "get", "iadd", "igt", "igte", "ilt", "ilte", "indices", "isub", "ite", "keys", "length", "map", "mapBy", "matchVariant", "neq", "not", "nth", "or", "put", "set", "size", "union", "variant", "with"],
    "runtimeObservationDependencies": ["name:state", "operator:eq", "operator:field", "path:state.counter"],
    "runtimeObservationDependencyDigest": "sha256:test"
  },
  "fixtures": { "projected_state": {} },
  "scenarios": [{
    "source": "projected_state.qnt",
    "module": "projected_state",
    "fixtureNamespace": "projected_state",
    "name": "advanceRun",
    "requiredCapabilities": ["state.advance"],
    "initialState": {"counter": 0, "untouched": 7},
    "steps": [
      { "index": 0, "kind": "init", "action": "init", "arguments": [] },
      {
        "index": 1,
        "kind": "action",
        "action": "advance",
        "arguments": [],
        "guards": [
          {
            "scope": "runtime",
            "expression": {
              "kind": "call",
              "operator": "eq",
              "arguments": [
                {
                  "kind": "call",
                  "operator": "field",
                  "arguments": [
                    {"kind": "name", "value": "state"},
                    {"kind": "str", "value": "counter"}
                  ]
                },
                {"kind": "int", "value": 0}
              ]
            },
            "dependencies": ["name:state", "operator:eq", "operator:field", "path:state.counter"]
          }
        ],
        "next": [
          {
            "scope": "model",
            "expression": {
              "kind": "call",
              "operator": "assign",
              "arguments": [
                {"kind": "name", "value": "state"},
                {
                  "kind": "call",
                  "operator": "with",
                  "arguments": [
                    {"kind": "name", "value": "state"},
                    {"kind": "str", "value": "counter"},
                    {"kind": "int", "value": 1}
                  ]
                }
              ]
            },
            "dependencies": ["name:state", "operator:assign", "operator:with", "path:state.counter"]
          },
          {
            "scope": "runtime",
            "expression": {
              "kind": "call",
              "operator": "eq",
              "arguments": [
                {
                  "kind": "call",
                  "operator": "field",
                  "arguments": [
                    {"kind": "name", "value": "state"},
                    {"kind": "str", "value": "counter"}
                  ]
                },
                {"kind": "int", "value": 1}
              ]
            },
            "dependencies": ["name:state", "operator:eq", "operator:field", "path:state.counter"]
          }
        ]
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

struct RecordEvidence(Result<RuntimeValue, String>);

impl NormalizedRuntimeEvidence for RecordEvidence {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        if name == "state" {
            self.0.clone()
        } else {
            Err(format!("unknown evidence name {name}"))
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

fn counter(value: i64) -> RecordEvidence {
    RecordEvidence(Ok(RuntimeValue::Record(std::collections::BTreeMap::from(
        [("counter".to_owned(), RuntimeValue::Int(value))],
    ))))
}

fn complete_initial() -> RecordEvidence {
    state_update([
        ("counter", RuntimeValue::Int(0)),
        ("untouched", RuntimeValue::Int(7)),
    ])
}

fn state_update(fields: impl IntoIterator<Item = (&'static str, RuntimeValue)>) -> RecordEvidence {
    RecordEvidence(Ok(RuntimeValue::Record(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    )))
}

struct Driver {
    calls: usize,
    short: bool,
}

struct RecordDriver {
    calls: usize,
}

struct StepDriver {
    arguments: Vec<RuntimeValue>,
}

impl AsyncActionDriver for StepDriver {
    type Evidence = RecordEvidence;

    async fn run_action(&mut self, action: &ResolvedAction) -> Result<Self::Evidence, String> {
        self.arguments.extend(action.arguments.clone());
        Ok(counter(1))
    }
}

impl AsyncPrimitiveDriver for RecordDriver {
    type Evidence = RecordEvidence;

    async fn run_primitive(
        &mut self,
        _primitive: &str,
        _actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String> {
        self.calls += 1;
        Ok(vec![counter(1)])
    }
}

impl AsyncPrimitiveDriver for Driver {
    type Evidence = Evidence;

    async fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String> {
        self.calls += 1;
        if primitive != "database.commit"
            || actions
                .iter()
                .map(|action| action.name.as_str())
                .ne(["prepare", "commit"])
            || actions
                .iter()
                .map(|action| action.arguments.as_slice())
                .ne([
                    [RuntimeValue::Int(1)].as_slice(),
                    [RuntimeValue::Int(2)].as_slice(),
                ])
        {
            return Err(format!(
                "unexpected async primitive tape {primitive} {actions:?}"
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

#[test]
fn false_pre_guard_stops_before_async_primitive_dispatch() {
    let mut artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse scenario");
    assert!(matches!(
        artifact.scenarios[0].steps[1],
        quint_refinements::ArtifactStep::Action { .. }
    ));
    if let quint_refinements::ArtifactStep::Action { guards, .. } =
        &mut artifact.scenarios[0].steps[1]
    {
        guards[0].expression["arguments"][1]["value"] = serde_json::json!(1);
    }
    let ownership = [OwnershipDescriptor {
        owner: "projected-state-test".to_owned(),
        primitive: "runtime.advance".to_owned(),
        refines: vec!["advance".to_owned()],
        aliases: Vec::new(),
        actions: vec!["advance".to_owned()],
        observations: Vec::new(),
        retrieve: Vec::new(),
    }];
    let mut driver = RecordDriver { calls: 0 };
    let error = block_on(refine_scenario_async(
        &artifact.scenarios[0],
        state_update([
            ("counter", RuntimeValue::Int(0)),
            ("untouched", RuntimeValue::Int(7)),
        ]),
        &ownership,
        &[
            "name:state",
            "operator:eq",
            "operator:field",
            "path:state.counter",
        ],
        &FixtureTable::new("projected_state"),
        &mut driver,
    ))
    .expect_err("false pre-guard must stop dispatch");

    assert!(error.contains("pre-guard"), "{error}");
    assert_eq!(driver.calls, 0);
}

#[test]
fn stepwise_driver_resolves_each_action_from_the_prior_reduced_state() {
    let mut artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse scenario");
    artifact.vocabulary.actions.push("finish".to_owned());
    let mut second = artifact.scenarios[0].steps[1].clone();
    let state_counter = serde_json::json!({
        "kind": "call",
        "operator": "field",
        "arguments": [
            {"kind": "name", "value": "state"},
            {"kind": "str", "value": "counter"}
        ]
    });
    if let quint_refinements::ArtifactStep::Action { arguments, .. } =
        &mut artifact.scenarios[0].steps[1]
    {
        *arguments = vec![state_counter.clone()];
    }
    if let quint_refinements::ArtifactStep::Action {
        index,
        action,
        arguments,
        guards,
        ..
    } = &mut second
    {
        *index = 2;
        *action = "finish".to_owned();
        *arguments = vec![state_counter];
        guards[0].expression["arguments"][1]["value"] = serde_json::json!(1);
    }
    artifact.scenarios[0].steps.push(second);
    let retrieve = [
        "name:state",
        "operator:assign",
        "operator:eq",
        "operator:field",
        "operator:with",
        "path:state.counter",
    ];
    let mut driver = StepDriver {
        arguments: Vec::new(),
    };

    let run = block_on(run_refined_actions_async(
        &artifact.scenarios[0],
        state_update([
            ("counter", RuntimeValue::Int(0)),
            ("untouched", RuntimeValue::Int(7)),
        ]),
        &retrieve,
        &FixtureTable::new("projected_state"),
        &mut driver,
    ))
    .expect("stepwise scenario refines");

    assert_eq!(
        driver.arguments,
        [RuntimeValue::Int(0), RuntimeValue::Int(1)]
    );
    assert_eq!(run.snapshots.len(), 3);
}

#[test]
fn projected_evaluator_carries_model_state_but_rejects_observed_divergence() {
    let artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse complete scenario");
    let scenario = &artifact.scenarios[0];
    let retrieve = [
        "name:state",
        "operator:assign",
        "operator:eq",
        "operator:field",
        "operator:with",
        "path:state.counter",
    ];

    assert_eq!(
        evaluate_projected_action_steps(scenario, &[complete_initial(), counter(1)], &retrieve)
            .expect("sparse concrete counter agrees with the full model state"),
        3
    );

    let error =
        evaluate_projected_action_steps(scenario, &[complete_initial(), counter(2)], &retrieve)
            .expect_err("a concrete counter divergence must fail");
    assert!(error.contains("state.counter"), "{error}");
}

#[test]
fn projected_evaluator_preserves_model_fields_omitted_by_sparse_runtime_evidence() {
    let artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse complete scenario");
    let scenario = &artifact.scenarios[0];
    let retrieve = [
        "name:state",
        "operator:assign",
        "operator:eq",
        "operator:field",
        "operator:with",
        "path:state.counter",
    ];

    assert_eq!(
        evaluate_projected_action_steps(scenario, &[complete_initial(), counter(1)], &retrieve)
            .expect("an omitted unchanged field keeps its prior Quint value"),
        3
    );
}

#[test]
fn projected_evaluator_rejects_an_omitted_changed_runtime_field() {
    let artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse complete scenario");
    let retrieve = [
        "name:state",
        "operator:assign",
        "operator:eq",
        "operator:field",
        "operator:with",
        "path:state.counter",
    ];

    let error = evaluate_projected_action_steps(
        &artifact.scenarios[0],
        &[complete_initial(), state_update([])],
        &retrieve,
    )
    .expect_err("a changed runtime-owned field requires Rust evidence");
    assert!(error.contains("omitted changed runtime-owned field state.counter"));
}

#[test]
fn projected_evaluator_rejects_fixture_drift_and_unknown_update_fields() {
    let artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse complete scenario");
    let scenario = &artifact.scenarios[0];
    let retrieve = [
        "name:state",
        "operator:assign",
        "operator:eq",
        "operator:field",
        "operator:with",
        "path:state.counter",
    ];

    let drift = evaluate_projected_action_steps(scenario, &[counter(9), counter(1)], &retrieve)
        .expect_err("the hydrated Rust fixture must match Quint initial state");
    assert!(drift.contains("Rust fixture does not match"), "{drift}");

    let mut retrieve_with_unknown = retrieve.to_vec();
    retrieve_with_unknown.push("path:state.not_in_model");
    let unknown = evaluate_projected_action_steps(
        scenario,
        &[
            complete_initial(),
            state_update([
                ("counter", RuntimeValue::Int(1)),
                ("not_in_model", RuntimeValue::Int(1)),
            ]),
        ],
        &retrieve_with_unknown,
    )
    .expect_err("Rust updates cannot add fields outside the hydrated state");
    assert!(unknown.contains("state.not_in_model"), "{unknown}");
}

#[test]
fn projected_evaluator_requires_readable_record_state_at_init() {
    let artifact = ConformanceArtifact::parse(COMPLETE_SCENARIO).expect("parse complete scenario");
    let retrieve = [
        "name:state",
        "operator:assign",
        "operator:eq",
        "operator:field",
        "operator:with",
        "path:state.counter",
    ];
    let snapshots = [
        RecordEvidence(Err("capture unavailable".to_owned())),
        counter(1),
    ];

    let error = evaluate_projected_action_steps(&artifact.scenarios[0], &snapshots, &retrieve)
        .expect_err("missing initial runtime state must fail closed");
    assert!(
        error.contains("init state evidence: capture unavailable"),
        "{error}"
    );
}
