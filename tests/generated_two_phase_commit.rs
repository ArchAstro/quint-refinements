#![allow(clippy::expect_used, dead_code)]

#[path = "../examples/two_phase_commit/coordinator.rs"]
mod coordinator;

use futures::executor::block_on;

#[test]
fn generated_commit_run_drives_one_async_command_across_three_quint_actions() {
    let evaluated = block_on(coordinator::refine_commit_run_async())
        .expect("generated commitRun refines through async package driver");

    assert_eq!(
        evaluated, 14,
        "begin plus prepare/flush/commit must evaluate every generated obligation",
    );
}
