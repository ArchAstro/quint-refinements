//! Executes the shared binding corpus in `conformance/cases` through the Rust
//! runtime. Every binding runs the same artifacts and must report the same
//! primitive calls, obligation count, and final state.

#![allow(clippy::expect_used, clippy::panic, dead_code)]

#[path = "../examples/two_phase_commit/coordinator.rs"]
mod coordinator;

use std::path::PathBuf;

use coordinator::{
    Coordinator, Snapshot,
    generated::{Driver, OWNERSHIP, RETRIEVE},
};
use quint_refinements::{
    ConformanceArtifact, PrimitiveDriver, ResolvedAction, RuntimeValue, collect_ownership_records,
    refine_scenario,
};
use serde_json::{Value, json};

fn case_file(case: &str, file: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/cases")
        .join(case)
        .join(file);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn argument_json(value: &RuntimeValue) -> Value {
    match value {
        RuntimeValue::Bool(value) => json!(value),
        RuntimeValue::Int(value) => json!(value),
        RuntimeValue::Text(value) => json!(value),
        other => panic!("corpus arguments are scalars; got {other:?}"),
    }
}

/// Records each primitive call on its way to the generated dispatcher.
struct Recorder {
    driver: Driver<Coordinator>,
    calls: Vec<Value>,
}

impl PrimitiveDriver for Recorder {
    type Evidence = Snapshot;

    fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Snapshot>, String> {
        self.calls.push(json!({
            "primitive": primitive,
            "actions": actions.iter().map(|action| action.name.as_str()).collect::<Vec<_>>(),
            "arguments": actions
                .iter()
                .flat_map(|action| action.arguments.iter().map(argument_json))
                .collect::<Vec<_>>(),
        }));
        self.driver.run_primitive(primitive, actions)
    }
}

#[test]
fn two_phase_commit_case_matches_the_shared_expectation() {
    // Setup: the corpus artifact and expectation, exactly as other bindings read them.
    let artifact = ConformanceArtifact::parse(&case_file("two_phase_commit", "artifact.json"))
        .expect("corpus artifact parses");
    let expected: Value = serde_json::from_str(&case_file("two_phase_commit", "expected.json"))
        .expect("corpus expectation parses");
    let scenario = artifact
        .scenarios
        .iter()
        .find(|scenario| Some(scenario.id().as_str()) == expected["scenario"].as_str())
        .expect("expected scenario is in the artifact");
    let ownership = collect_ownership_records(&[OWNERSHIP]).expect("ownership");
    let fixtures = coordinator::fixture_table();
    fixtures.validate(&artifact).expect("fixtures match");

    // Action: refine the scenario against the real coordinator.
    let mut recorder = Recorder {
        driver: Driver {
            implementation: Coordinator::new(),
        },
        calls: Vec::new(),
    };
    let initial = recorder.driver.implementation.snapshot();
    let evaluated = refine_scenario(
        scenario,
        initial,
        &ownership,
        RETRIEVE,
        &fixtures,
        &mut recorder,
    )
    .expect("corpus scenario refines");

    // Outcome: calls, obligations, and final state all match the shared case.
    assert_eq!(Value::Array(recorder.calls), expected["primitiveCalls"]);
    assert_eq!(json!(evaluated), expected["evaluatedObligations"]);
    let last = recorder.driver.implementation.snapshot();
    assert_eq!(
        json!({
            "status": format!("{:?}", last.status),
            "flushed": last.flushed,
            "wal": last.wal,
        }),
        expected["finalState"],
    );
}
