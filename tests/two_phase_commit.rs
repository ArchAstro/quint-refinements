#![allow(clippy::expect_used, clippy::panic)]

#[path = "../examples/two_phase_commit/coordinator.rs"]
mod coordinator;

#[test]
fn commit_command_refines_prepare_flush_and_commit_records() {
    let evaluated = coordinator::refine_commit_run().expect("commitRun refines");
    assert!(
        evaluated >= 8,
        "begin plus three commit-tape steps must evaluate guards and next, got {evaluated}"
    );
}
