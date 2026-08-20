#![forbid(unsafe_code)]

//! Quint refinement framework.
//!
//! A Quint app generates a JSON artifact of scenarios. Rust primitives declare
//! which model actions they own. The runner walks the JSON, looks up ownership,
//! and calls [`PrimitiveDriver::run_primitive`]. The driver must return one
//! evidence snapshot per owned action. There is no other way to fill a tape.

mod artifact;
mod drive;
mod error;
mod evaluate;
mod ownership;
mod schedule;

pub use artifact::{
    ArtifactAssertion, ArtifactScenario, ArtifactStep, ArtifactVocabulary, AssertionScope,
    ConformanceArtifact,
};
pub use drive::{PrimitiveDriver, refine_scenario};
pub use error::Error;
pub use evaluate::{
    NormalizedRuntimeEvidence, RuntimeValue, evaluate_chapter_next, evaluate_every_action_step,
    evaluate_preceding_action_next, evaluate_runtime_assertions, evaluate_step_obligations,
};
pub use ownership::{
    AggregationError, OwnershipDescriptor, OwnershipRecord, OwnershipTable, PrimitiveId,
    collect_ownership_records,
};
pub use schedule::{
    ScheduledPrimitiveRun, collect_owned_action_snapshots, scenario_action_names,
    schedule_primitive_runs,
};
