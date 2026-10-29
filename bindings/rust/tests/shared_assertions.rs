//! Schema v3 stores each distinct obligation list once; v2 writes them inline.
//! Both load into the same steps, and a bad reference is an error.

#![allow(clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use quint_refinements::{ArtifactStep, ConformanceArtifact};

const EQ_ONE: &str = r#"{"scope":"runtime","expression":{"kind":"call","operator":"eq","arguments":[{"kind":"name","value":"state"},{"kind":"int","value":1}]}}"#;

fn artifact(version: u32, extra: &str, steps: &str) -> String {
    format!(
        r#"{{
  "schemaVersion": {version},
  "modelDigest": "sha256:shared-assertions-test",
  "vocabulary": {{
    "actions": ["step"],
    "capabilities": [],
    "expressionOperators": [],
    "expressionNames": [],
    "runtimeObservationDependencies": [],
    "runtimeObservationDependencyDigest": "sha256:test"
  }},
  "fixtures": {{}},
  {extra}
  "scenarios": [{{
    "source": "s.qnt",
    "module": "s",
    "fixtureNamespace": "s",
    "name": "run",
    "requiredCapabilities": [],
    "steps": [{steps}]
  }}]
}}"#
    )
}

fn action(fields: &str) -> String {
    format!(r#"{{"index":1,"kind":"action","action":"step","arguments":[],{fields}}}"#)
        .replace(",}", "}")
}

fn parse_error(json: &str) -> String {
    ConformanceArtifact::parse(json)
        .expect_err("artifact must be rejected")
        .to_string()
}

fn action_lists(artifact: &ConformanceArtifact, step: usize) -> (usize, usize) {
    match &artifact.scenarios[0].steps[step] {
        ArtifactStep::Action { guards, next, .. } => (guards.len(), next.len()),
        other => panic!("expected an action, found {other:?}"),
    }
}

#[test]
fn v3_steps_resolve_their_shared_lists() {
    let lists = format!(r#""assertionLists": [[{EQ_ONE}], [{EQ_ONE}, {EQ_ONE}]],"#);
    let steps = format!(
        "{},{}",
        action(r#""guardList":0,"nextList":1"#),
        action(r#""nextList":1"#)
    );
    let parsed = ConformanceArtifact::parse(&artifact(3, &lists, &steps)).expect("v3 loads");
    assert_eq!(parsed.schema_version, 3);
    assert_eq!(action_lists(&parsed, 0), (1, 2));
    assert_eq!(action_lists(&parsed, 1), (0, 2));
}

#[test]
fn v2_inline_lists_still_load() {
    let steps = action(&format!(r#""guards":[{EQ_ONE}],"next":[{EQ_ONE}]"#));
    let parsed = ConformanceArtifact::parse(&artifact(2, "", &steps)).expect("v2 loads");
    assert_eq!(parsed.schema_version, 2);
    assert_eq!(action_lists(&parsed, 0), (1, 1));
}

#[test]
fn v2_and_v3_corpus_artifacts_resolve_to_the_same_steps() {
    let read = |case: &str| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../conformance/cases")
            .join(case)
            .join("artifact.json");
        let json = std::fs::read_to_string(&path).expect("corpus artifact");
        ConformanceArtifact::parse(&json).expect("corpus artifact loads")
    };
    let v2 = read("bank_withdraw_v2");
    let v3 = read("bank_withdraw");
    assert_eq!(v2.schema_version, 2);
    assert_eq!(v3.schema_version, 3);
    assert_eq!(format!("{:?}", v2.scenarios), format!("{:?}", v3.scenarios));
}

#[test]
fn an_out_of_range_reference_is_rejected() {
    let lists = format!(r#""assertionLists": [[{EQ_ONE}]],"#);
    let guard = parse_error(&artifact(3, &lists, &action(r#""guardList":1"#)));
    assert!(guard.contains("`guardList` 1 is out of range"), "{guard}");
    assert!(guard.contains("1 assertion lists"), "{guard}");
    let next = parse_error(&artifact(3, "", &action(r#""nextList":0"#)));
    assert!(next.contains("`nextList` 0 is out of range"), "{next}");
}

#[test]
fn schema_versions_do_not_mix_forms() {
    let lists = format!(r#""assertionLists": [[{EQ_ONE}]],"#);
    let inline_in_v3 = parse_error(&artifact(
        3,
        &lists,
        &action(&format!(r#""guards":[{EQ_ONE}]"#)),
    ));
    assert!(inline_in_v3.contains("inline"), "{inline_in_v3}");
    let list_in_v2 = parse_error(&artifact(2, "", &action(r#""guardList":0"#)));
    assert!(list_in_v2.contains("schema version 3"), "{list_in_v2}");
    let table_in_v2 = parse_error(&artifact(2, &lists, &action("")));
    assert!(table_in_v2.contains("assertionLists"), "{table_in_v2}");
    let unknown = parse_error(&artifact(4, "", &action("")));
    assert!(
        unknown.contains("unsupported schema version 4"),
        "{unknown}"
    );
}
