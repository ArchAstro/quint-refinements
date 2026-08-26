//! Validates that checked-in Quint fixtures are owned by matching Rust values.

use quint_refinements::{ConformanceArtifact, FixtureTable};

const ARTIFACT: &str = r#"{
  "schemaVersion": 2,
  "modelDigest": "sha256:example",
  "vocabulary": {
    "actions": [], "capabilities": [], "expressionOperators": [],
    "expressionNames": [], "runtimeObservationDependencies": [],
    "runtimeObservationDependencyDigest": "sha256:example"
  },
  "fixtures": { "counter": { "initialCount": 0, "owner": "worker-a" } },
  "scenarios": []
}"#;

fn main() {
    let artifact = match ConformanceArtifact::parse(ARTIFACT) {
        Ok(artifact) => artifact,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let fixtures = FixtureTable::new("counter")
        .insert("initialCount", &0_i64)
        .insert("owner", &"worker-a");
    if let Err(error) = fixtures.validate(&artifact) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    println!("validated fixtures: {:?}", fixtures.names());
}
