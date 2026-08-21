#![allow(clippy::expect_used, clippy::panic)]

#[path = "../examples/two_phase_commit/coordinator.rs"]
mod coordinator;

use coordinator::Status;
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
    let ownership = collect_ownership_records(&[coordinator::OWNERSHIP]).expect("ownership");
    let fixtures = FixtureTable::new("two_phase_commit")
        .insert_set("statuses", &[Status::Open, Status::Prepared]);
    let mut driver = coordinator::Coordinator::new();
    let error = refine_scenario(
        scenario,
        driver.snapshot(),
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
