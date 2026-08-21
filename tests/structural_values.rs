#![allow(clippy::expect_used)]

use std::collections::BTreeMap;

use quint_refinements::{
    ArtifactAssertion, AssertionScope, ConformanceArtifact, FixtureTable,
    NormalizedRuntimeEvidence, QuintFixture, RuntimeValue, evaluate_all_step_obligations,
    evaluate_refined_tape,
};
use serde_json::{Value, json};

struct PoolKey;

impl QuintFixture for PoolKey {
    fn artifact_json(&self) -> Value {
        json!({ "org_id": "org-a", "service_spec_id": "service-a" })
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Record(BTreeMap::from([
            ("org_id".to_owned(), RuntimeValue::Text("org-a".to_owned())),
            (
                "service_spec_id".to_owned(),
                RuntimeValue::Text("service-a".to_owned()),
            ),
        ]))
    }
}

struct PartialRecordFixture;

impl QuintFixture for PartialRecordFixture {
    fn artifact_json(&self) -> Value {
        json!({ "kept": 1 })
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Record(BTreeMap::from([("kept".to_owned(), RuntimeValue::Int(1))]))
    }
}

struct Evidence(RuntimeValue);

impl NormalizedRuntimeEvidence for Evidence {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(self.0.clone()),
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

fn state(pool_counts: BTreeMap<RuntimeValue, RuntimeValue>) -> Evidence {
    Evidence(RuntimeValue::Record(BTreeMap::from([(
        "pool_counts".to_owned(),
        RuntimeValue::Map(pool_counts),
    )])))
}

fn call(operator: &str, arguments: Vec<Value>) -> Value {
    json!({ "kind": "call", "operator": operator, "arguments": arguments })
}

fn int(value: i64) -> Value {
    json!({ "kind": "int", "value": value })
}

fn text(value: &str) -> Value {
    json!({ "kind": "str", "value": value })
}

fn lambda(parameters: &[&str], body: Value) -> Value {
    json!({ "kind": "lambda", "parameters": parameters, "body": body })
}

fn name(value: &str) -> Value {
    json!({ "kind": "name", "value": value })
}

fn assertion(expression: Value) -> ArtifactAssertion {
    ArtifactAssertion {
        scope: AssertionScope::Model,
        expression,
        dependencies: Vec::new(),
    }
}

fn state_assignment() -> ArtifactAssertion {
    assertion(call("assign", vec![name("state"), name("state")]))
}

fn record_evidence(fields: &[(&str, RuntimeValue)]) -> Evidence {
    Evidence(RuntimeValue::Record(
        fields
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect(),
    ))
}

#[test]
fn record_keyed_quint_map_get_and_set_refine_across_snapshots() {
    let artifact = ConformanceArtifact::parse(
        r#"{
          "schemaVersion": 2,
          "modelDigest": "sha256:test",
          "vocabulary": {
            "actions": ["incrementPool"],
            "capabilities": ["test"],
            "expressionOperators": [],
            "expressionNames": [],
            "runtimeObservationDependencies": [],
            "runtimeObservationDependencyDigest": "sha256:test"
          },
          "fixtures": { "model": { "poolA": { "org_id": "org-a", "service_spec_id": "service-a" } } },
          "scenarios": [{
            "source": "model.qnt",
            "module": "model",
            "fixtureNamespace": "model",
            "name": "poolRun",
            "requiredCapabilities": ["test"],
            "steps": [
              { "index": 0, "kind": "init", "action": "init", "arguments": [] },
              {
                "index": 1,
                "kind": "action",
                "action": "incrementPool",
                "arguments": [],
                "guards": [{
                  "scope": "model",
                  "expression": {
                    "kind": "call", "operator": "eq", "arguments": [
                      { "kind": "call", "operator": "get", "arguments": [
                        { "kind": "call", "operator": "field", "arguments": [
                          { "kind": "name", "value": "state" },
                          { "kind": "str", "value": "pool_counts" }
                        ] },
                        { "kind": "name", "value": "poolA" }
                      ] },
                      { "kind": "name", "value": "Absent" }
                    ]
                  }
                }],
                "next": [{
                  "scope": "model",
                  "expression": {
                    "kind": "call", "operator": "assign", "arguments": [
                      { "kind": "name", "value": "state" },
                      { "kind": "call", "operator": "with", "arguments": [
                        { "kind": "name", "value": "state" },
                        { "kind": "str", "value": "pool_counts" },
                        { "kind": "call", "operator": "set", "arguments": [
                          { "kind": "call", "operator": "field", "arguments": [
                            { "kind": "name", "value": "state" },
                            { "kind": "str", "value": "pool_counts" }
                          ] },
                          { "kind": "name", "value": "poolA" },
                          { "kind": "int", "value": 1 }
                        ] }
                      ] }
                    ]
                  }
                }]
              }
            ]
          }]
        }"#,
    )
    .expect("parse structural map scenario");
    let fixtures = FixtureTable::new("model").insert("poolA", &PoolKey);
    let pool_a = PoolKey.runtime_value();
    let snapshots = [
        state(BTreeMap::from([(pool_a.clone(), RuntimeValue::Absent)])),
        state(BTreeMap::from([(pool_a, RuntimeValue::Int(1))])),
    ];

    let evaluated = evaluate_refined_tape(
        &artifact.scenarios[0],
        &snapshots,
        &["name:state", "operator:with", "operator:set"],
        &fixtures,
    )
    .expect("record-keyed map must refine");

    assert_eq!(evaluated, 2, "guard and next assignment must both run");
}

#[test]
fn generated_collection_operators_follow_quint_structural_semantics() {
    let set = |values: Vec<Value>| call("Set", values);
    let list = |values: Vec<Value>| call("List", values);
    let eq = |left: Value, right: Value| assertion(call("eq", vec![left, right]));
    let map_identity = call(
        "mapBy",
        vec![
            set(vec![text("a"), text("b")]),
            lambda(&["value"], name("value")),
        ],
    );
    let assertions = vec![
        eq(
            call("concat", vec![list(vec![int(1)]), list(vec![int(2)])]),
            list(vec![int(1), int(2)]),
        ),
        eq(
            call("nth", vec![list(vec![text("a"), text("b")]), int(1)]),
            text("b"),
        ),
        eq(
            call("indices", vec![list(vec![text("a"), text("b")])]),
            set(vec![int(0), int(1)]),
        ),
        eq(
            call(
                "exclude",
                vec![set(vec![text("a"), text("b")]), set(vec![text("b")])],
            ),
            set(vec![text("a")]),
        ),
        eq(
            call("keys", vec![map_identity.clone()]),
            set(vec![text("a"), text("b")]),
        ),
        eq(call("get", vec![map_identity, text("a")]), text("a")),
        eq(
            call(
                "fold",
                vec![
                    set(vec![int(1), int(2)]),
                    int(0),
                    lambda(
                        &["sum", "value"],
                        call("iadd", vec![name("sum"), name("value")]),
                    ),
                ],
            ),
            int(3),
        ),
        eq(
            call(
                "filter",
                vec![
                    set(vec![int(1), int(2)]),
                    lambda(&["value"], call("igt", vec![name("value"), int(1)])),
                ],
            ),
            set(vec![int(2)]),
        ),
        eq(
            call(
                "map",
                vec![
                    set(vec![int(1), int(2)]),
                    lambda(&["value"], call("iadd", vec![name("value"), int(1)])),
                ],
            ),
            set(vec![int(2), int(3)]),
        ),
        eq(
            call(
                "get",
                vec![
                    call(
                        "put",
                        vec![
                            call("Map", vec![call("Tup", vec![text("a"), int(1)])]),
                            text("b"),
                            int(2),
                        ],
                    ),
                    text("b"),
                ],
            ),
            int(2),
        ),
    ];
    let evidence = state(BTreeMap::new());

    let evaluated = evaluate_all_step_obligations(
        "structural_values.collectionRun",
        "exerciseCollections",
        &assertions,
        &[],
        &evidence,
        &evidence,
        &[],
    )
    .expect("generated collection operators must evaluate");

    assert_eq!(evaluated, assertions.len());
}

#[test]
fn exact_assignment_rejects_an_omitted_model_state_field() {
    let before = record_evidence(&[("required", RuntimeValue::Int(1))]);
    let after = record_evidence(&[]);

    let error = evaluate_all_step_obligations(
        "structural_values.exactRun",
        "dropRequiredField",
        &[],
        &[state_assignment()],
        &before,
        &after,
        &[],
    )
    .expect_err("omitted model field must fail");

    assert!(error.contains("required"), "{error}");
}

#[test]
fn exact_assignment_rejects_an_unexpected_model_state_field() {
    let before = record_evidence(&[("required", RuntimeValue::Int(1))]);
    let after = record_evidence(&[
        ("required", RuntimeValue::Int(1)),
        ("invented", RuntimeValue::Bool(true)),
    ]);

    let error = evaluate_all_step_obligations(
        "structural_values.exactRun",
        "inventUnexpectedField",
        &[],
        &[state_assignment()],
        &before,
        &after,
        &[],
    )
    .expect_err("unexpected model field must fail");

    assert!(error.contains("invented"), "{error}");
}

#[test]
fn full_fixture_validation_rejects_an_omitted_record_field() {
    let artifact = ConformanceArtifact::parse(
        r#"{
          "schemaVersion": 2,
          "modelDigest": "sha256:fixture-test",
          "vocabulary": {
            "actions": [],
            "capabilities": [],
            "expressionOperators": [],
            "expressionNames": [],
            "runtimeObservationDependencies": [],
            "runtimeObservationDependencyDigest": "sha256:test"
          },
          "fixtures": { "model": { "record": { "kept": 1, "omitted": 2 } } },
          "scenarios": []
        }"#,
    )
    .expect("parse fixture artifact");

    let error = FixtureTable::new("model")
        .insert("record", &PartialRecordFixture)
        .validate(&artifact)
        .expect_err("full fixture validation cannot accept a record subset");

    assert!(
        error.message().contains("JSON diverged"),
        "{}",
        error.message()
    );
}
