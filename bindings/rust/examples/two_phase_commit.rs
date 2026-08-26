//! `cargo run --example two_phase_commit`
//!
//! Quint `commitRun` is begin, prepare, flushWal, commitPrepared.
//! Rust `commit()` is one function that refines the last three.

#[path = "two_phase_commit/coordinator.rs"]
mod coordinator;

fn main() {
    match coordinator::refine_commit_run() {
        Ok(evaluated) => {
            println!("two-phase commit refined {evaluated} runtime assertions");
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
