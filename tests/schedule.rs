#![allow(clippy::expect_used, clippy::panic)]

use quint_refinements::{
    OwnershipDescriptor, collect_owned_action_snapshots, schedule_primitive_runs,
};

fn refines(primitive: &str, steps: &[&str]) -> OwnershipDescriptor {
    OwnershipDescriptor {
        owner: "test".to_owned(),
        primitive: primitive.to_owned(),
        refines: steps.iter().map(|action| (*action).to_owned()).collect(),
        aliases: Vec::new(),
        actions: steps.iter().map(|action| (*action).to_owned()).collect(),
        observations: Vec::new(),
        retrieve: Vec::new(),
    }
}

fn one_step(primitive: &str, step: &str, aliases: &[&str]) -> OwnershipDescriptor {
    OwnershipDescriptor {
        owner: "test".to_owned(),
        primitive: primitive.to_owned(),
        refines: vec![step.to_owned()],
        aliases: aliases.iter().map(|action| (*action).to_owned()).collect(),
        actions: std::iter::once(step)
            .chain(aliases.iter().copied())
            .map(str::to_owned)
            .collect(),
        observations: Vec::new(),
        retrieve: Vec::new(),
    }
}

#[test]
fn consecutive_owned_actions_schedule_one_compound_tape() {
    let ownership = [refines(
        "gateway.delivery.enqueue",
        &[
            "submitInvocation",
            "selectForAttempt",
            "enqueueSelectedDelivery",
        ],
    )];
    let runs = schedule_primitive_runs(
        &[
            "submitInvocation",
            "selectForAttempt",
            "enqueueSelectedDelivery",
        ],
        &ownership,
    )
    .expect("schedule");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].primitive, "gateway.delivery.enqueue");
    assert_eq!(runs[0].owned_actions.len(), 3);
}

#[test]
fn alias_actions_schedule_one_evidence_each() {
    let ownership = [
        one_step(
            "gateway.connection.register",
            "openConnection",
            &["openConnectionForRuntimeOwner"],
        ),
        one_step("gateway.connection.receive_hello", "receiveHello", &[]),
    ];
    let runs = schedule_primitive_runs(
        &["openConnection", "receiveHello", "openConnection"],
        &ownership,
    )
    .expect("schedule");
    assert_eq!(runs.len(), 3);
    assert_eq!(runs[0].owned_actions, ["openConnection"]);
    assert_eq!(runs[2].owned_actions, ["openConnection"]);
}

#[test]
fn partial_compound_json_fails_closed() {
    let ownership = [refines(
        "gateway.delivery.enqueue",
        &[
            "submitInvocation",
            "selectForAttempt",
            "enqueueSelectedDelivery",
        ],
    )];
    let error = match schedule_primitive_runs(&["submitInvocation", "selectForAttempt"], &ownership)
    {
        Err(error) => error,
        Ok(_) => panic!("partial compound must fail"),
    };
    assert!(error.contains("are not the owned sequence"), "{error}");
}

#[test]
fn aliases_on_a_compound_sequence_fail_closed() {
    use quint_refinements::{
        AggregationError, OwnershipRecord, OwnershipTable, PrimitiveId, collect_ownership_records,
    };
    const RECORD: OwnershipRecord = OwnershipRecord {
        primitive: PrimitiveId::new("p"),
        refines: &["a", "b"],
        aliases: &["a-prime"],
        actions: &[],
        observations: &[],
        retrieve: &[],
    };
    let error = collect_ownership_records(&[OwnershipTable {
        owner: "test",
        descriptors: &[RECORD],
    }]);
    assert!(matches!(
        error,
        Err(AggregationError::AliasesOnCompoundSequence { .. })
    ));
}

#[test]
fn compound_tape_must_return_one_evidence_per_owned_action() {
    let scenario = quint_refinements::ConformanceArtifact::parse(
        r#"{
          "schemaVersion": 2,
          "modelDigest": "sha256:test",
          "vocabulary": {
            "actions": ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"],
            "capabilities": ["transport.basic"],
            "expressionOperators": [],
            "expressionNames": [],
            "runtimeObservationDependencies": [],
            "runtimeObservationDependencyDigest": "sha256:test"
          },
          "fixtures": { "m": {} },
          "scenarios": [{
            "source": "m.qnt",
            "module": "m",
            "fixtureNamespace": "m",
            "name": "run",
            "requiredCapabilities": ["transport.basic"],
            "steps": [
              {"index": 0, "kind": "init", "action": "init", "arguments": []},
              {"index": 1, "kind": "action", "action": "submitInvocation", "arguments": []},
              {"index": 2, "kind": "action", "action": "selectForAttempt", "arguments": []},
              {"index": 3, "kind": "action", "action": "enqueueSelectedDelivery", "arguments": []}
            ]
          }]
        }"#,
    )
    .expect("parse");
    let ownership = [refines(
        "gateway.delivery.enqueue",
        &[
            "submitInvocation",
            "selectForAttempt",
            "enqueueSelectedDelivery",
        ],
    )];
    let error = match collect_owned_action_snapshots(
        &scenario.scenarios[0],
        0_u8,
        &ownership,
        |_primitive, _owned| Ok(vec![1]),
    ) {
        Err(error) => error,
        Ok(_) => panic!("short tape must fail"),
    };
    assert!(
        error.contains("owns 3 actions but returned 1 evidence"),
        "{error}"
    );
}
