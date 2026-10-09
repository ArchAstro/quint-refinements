#![allow(clippy::expect_used, clippy::panic)]

#[path = "../examples/two_phase_commit/coordinator.rs"]
mod coordinator;

use coordinator::{
    Status,
    generated::{Driver, OWNERSHIP},
};
use quint_refinements::{
    ConformanceArtifact, FixtureTable, collect_ownership_records, refine_scenario,
};

const TRACES: &str = include_str!("../examples/two_phase_commit/traces.json");

#[test]
fn commit_command_refines_prepare_flush_and_commit_records() {
    let evaluated = coordinator::refine_commit_run().expect("commitRun refines");
    assert_eq!(
        evaluated, 14,
        "every begin/prepare/flush/commit conjunct must run, including model-scope set membership"
    );
}

#[test]
fn rust_status_fixtures_must_match_quint_json() {
    let artifact = ConformanceArtifact::parse(TRACES).expect("parse");
    coordinator::fixture_table()
        .validate(&artifact)
        .expect("Status is the Quint fixture");
}

#[test]
fn missing_fixture_owner_fails_closed() {
    let artifact = ConformanceArtifact::parse(TRACES).expect("parse");
    let error = FixtureTable::new("two_phase_commit")
        .validate(&artifact)
        .expect_err("missing statuses fixture owner");
    assert!(
        error.message().contains("names differ"),
        "{}",
        error.message()
    );
}

#[test]
fn universe_set_without_idle_fails_the_begin_membership_guard() {
    let artifact = ConformanceArtifact::parse(TRACES).expect("parse");
    let scenario = artifact.scenarios.first().expect("commitRun");
    let ownership = collect_ownership_records(&[OWNERSHIP]).expect("ownership");
    let fixtures = FixtureTable::new("two_phase_commit")
        .insert_set("statuses", &[Status::Open, Status::Prepared]);
    let mut driver = Driver {
        implementation: coordinator::Coordinator::new(),
    };
    let error = refine_scenario(
        scenario,
        driver.implementation.snapshot(),
        &ownership,
        &[
            "name:state",
            "operator:contains",
            "operator:eq",
            "operator:field",
            "path:state.flushed",
            "path:state.status",
        ],
        &fixtures,
        &mut driver,
    )
    .expect_err("Idle is not in the rust statuses set");
    assert!(error.contains("guard assertion evaluated false"), "{error}");
}

#[test]
fn fixtures_can_take_their_values_from_the_model() {
    let artifact = ConformanceArtifact::parse(TRACES).expect("parse");

    let fixtures =
        FixtureTable::from_artifact("two_phase_commit", &artifact).expect("model fixtures decode");

    fixtures
        .validate(&artifact)
        .expect("model-derived fixtures own every name");
    // Unit constructors decode to the same tags the evaluator compares against.
    assert_eq!(
        fixtures.get("statuses"),
        coordinator::fixture_table().get("statuses"),
    );
    assert_eq!(
        FixtureTable::from_artifact("no_such_module", &artifact)
            .expect("an absent namespace is empty")
            .names(),
        Vec::<&str>::new(),
    );
}
