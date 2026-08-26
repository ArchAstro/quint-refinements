//! Shows two cardinality checks that prevent partial refinement tapes.

use quint_refinements::{
    OwnershipDescriptor, collect_owned_action_snapshots, schedule_primitive_runs,
};

fn ownership() -> OwnershipDescriptor {
    let actions = ["prepare", "flushWal", "commitPrepared"]
        .map(str::to_owned)
        .to_vec();
    OwnershipDescriptor {
        owner: "example".to_owned(),
        primitive: "transaction.commit".to_owned(),
        refines: actions.clone(),
        aliases: Vec::new(),
        actions,
        observations: Vec::new(),
        retrieve: Vec::new(),
    }
}

fn main() {
    let descriptor = ownership();
    match schedule_primitive_runs(&["prepare", "flushWal"], std::slice::from_ref(&descriptor)) {
        Err(error) => println!("partial sequence rejected: {error}"),
        Ok(_) => {
            eprintln!("partial sequence unexpectedly passed");
            std::process::exit(1);
        }
    }

    let artifact = match quint_refinements::ConformanceArtifact::parse(include_str!(
        "two_phase_commit/traces.json"
    )) {
        Ok(artifact) => artifact,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let begin = OwnershipDescriptor {
        owner: "example".to_owned(),
        primitive: "transaction.begin".to_owned(),
        refines: vec!["begin".to_owned()],
        aliases: Vec::new(),
        actions: vec!["begin".to_owned()],
        observations: Vec::new(),
        retrieve: Vec::new(),
    };
    match collect_owned_action_snapshots(
        &artifact.scenarios[0],
        0_u8,
        &[begin, descriptor],
        |primitive, owned| {
            let count = if primitive == "transaction.commit" {
                owned.len().saturating_sub(1)
            } else {
                owned.len()
            };
            Ok(vec![1_u8; count])
        },
    ) {
        Err(error) => println!("short evidence tape rejected: {error}"),
        Ok(_) => {
            eprintln!("short evidence tape unexpectedly passed");
            std::process::exit(1);
        }
    }
}
