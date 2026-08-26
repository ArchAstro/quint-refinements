//! Declares one-step, aliased, and compound implementation ownership.

use quint_refinements::{OwnershipTable, collect_ownership_records, quint_ownership};

quint_ownership! {
    const OPEN = {
        primitive: "connection.open",
        refines: ["openConnection"],
        aliases: ["openConnectionForOwner"],
        observations: ["path:state.connections"],
        retrieve: ["name:state"],
    };
}

quint_ownership! {
    const COMMIT = {
        primitive: "transaction.commit",
        refines: ["prepare", "flush", "commit"],
        aliases: [],
        observations: ["path:state.status"],
        retrieve: ["name:state"],
    };
}

fn main() {
    let tables = [OwnershipTable {
        owner: "example",
        descriptors: &[OPEN, COMMIT],
    }];
    match collect_ownership_records(&tables) {
        Ok(records) => {
            for record in records {
                println!("{} refines {:?}", record.primitive, record.refines);
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
