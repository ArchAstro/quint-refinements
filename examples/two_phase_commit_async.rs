//! `cargo run --example two_phase_commit_async`
//!
//! Runs the same generated Quint scenario through the runtime-neutral async API.

#[allow(dead_code)]
#[path = "two_phase_commit/coordinator.rs"]
mod coordinator;

fn main() {
    match futures::executor::block_on(coordinator::refine_commit_run_async()) {
        Ok(evaluated) => {
            println!("async two-phase commit refined {evaluated} runtime assertions");
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
