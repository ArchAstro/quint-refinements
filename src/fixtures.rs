use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::artifact::{ArtifactScenario, ArtifactStep, ConformanceArtifact};
use crate::error::Error;
use crate::evaluate::{NormalizedRuntimeEvidence, RuntimeValue};

/// A Rust value that owns one Quint fixture name.
///
/// Implement this on the production (or example) struct, not a test twin.
/// [`FixtureTable::validate`] compares [`QuintFixture::artifact_json`] to the
/// generated JSON so field drift fails closed.
pub trait QuintFixture {
    fn artifact_json(&self) -> Value;
    fn runtime_value(&self) -> RuntimeValue;
}

/// Named Quint fixtures backed by Rust values, one namespace per model module.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixtureTable {
    pub namespace: String,
    values: BTreeMap<String, RuntimeValue>,
    json: BTreeMap<String, Value>,
}

impl FixtureTable {
    #[must_use]
    pub fn new(namespace: impl Into<String>) -> Self {
        Self {
            namespace: namespace.into(),
            values: BTreeMap::new(),
            json: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn insert(mut self, name: &str, fixture: &impl QuintFixture) -> Self {
        self.values.insert(name.to_owned(), fixture.runtime_value());
        self.json.insert(name.to_owned(), fixture.artifact_json());
        self
    }

    #[must_use]
    pub fn insert_set<F: QuintFixture>(mut self, name: &str, members: &[F]) -> Self {
        let mut json_members = members
            .iter()
            .map(QuintFixture::artifact_json)
            .collect::<Vec<_>>();
        json_members.sort_by_key(ToString::to_string);
        let mut set = BTreeSet::new();
        for member in members {
            if let RuntimeValue::Text(value) = member.runtime_value() {
                set.insert(value);
            }
        }
        self.values.insert(name.to_owned(), RuntimeValue::Set(set));
        self.json
            .insert(name.to_owned(), Value::Array(json_members));
        self
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&RuntimeValue> {
        self.values.get(name)
    }

    #[must_use]
    pub fn contains_name(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    #[must_use]
    pub fn names(&self) -> Vec<&str> {
        self.values.keys().map(String::as_str).collect()
    }

    #[must_use]
    pub fn retrieve_names(&self) -> Vec<String> {
        self.names()
            .into_iter()
            .map(|name| format!("name:{name}"))
            .collect()
    }

    /// Every JSON fixture in this namespace must have a Rust owner with equal JSON.
    pub fn validate(&self, artifact: &ConformanceArtifact) -> Result<(), Error> {
        let Some(expected) = artifact.fixtures.get(&self.namespace) else {
            return Err(Error::new(format!(
                "fixture namespace {} is missing from the artifact",
                self.namespace
            )));
        };
        if expected.keys().ne(self.json.keys()) {
            return Err(Error::new(format!(
                "fixture namespace {} names differ: artifact {:?} rust {:?}",
                self.namespace,
                expected.keys().collect::<Vec<_>>(),
                self.json.keys().collect::<Vec<_>>()
            )));
        }
        for (name, rust_json) in &self.json {
            let Some(artifact_json) = expected.get(name) else {
                return Err(Error::new(format!("artifact is missing fixture {name}")));
            };
            if artifact_json != rust_json {
                return Err(Error::new(format!(
                    "fixture {name} JSON diverged: artifact {artifact_json} rust {rust_json}"
                )));
            }
        }
        for scenario in &artifact.scenarios {
            if scenario.fixture_namespace == self.namespace {
                validate_scenario_names(scenario, self)?;
            }
        }
        Ok(())
    }
}

/// Snapshot evidence with fixture names in front of live `state`.
pub struct BoundEvidence<'a, E> {
    pub fixtures: &'a FixtureTable,
    pub snapshot: &'a E,
}

impl<E: NormalizedRuntimeEvidence> NormalizedRuntimeEvidence for BoundEvidence<'_, E> {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        if let Some(value) = self.fixtures.get(name) {
            return Ok(value.clone());
        }
        self.snapshot.resolve_name(name)
    }

    fn resolve_call(
        &self,
        operator: &str,
        arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        self.snapshot.resolve_call(operator, arguments)
    }
}

fn validate_scenario_names(
    scenario: &ArtifactScenario,
    fixtures: &FixtureTable,
) -> Result<(), Error> {
    for step in &scenario.steps {
        let ArtifactStep::Action {
            action,
            guards,
            next,
            ..
        } = step
        else {
            continue;
        };
        for assertion in guards.iter().chain(next.iter()) {
            for name in expression_names(&assertion.expression) {
                if name == "state" || fixtures.contains_name(&name) {
                    continue;
                }
                return Err(Error::new(format!(
                    "{}:{action} names {name} but neither fixtures nor snapshot state own it",
                    scenario.id()
                )));
            }
        }
    }
    Ok(())
}

fn expression_names(expression: &Value) -> Vec<String> {
    match expression["kind"].as_str() {
        Some("name") => expression["value"]
            .as_str()
            .map(|name| vec![name.to_owned()])
            .unwrap_or_default(),
        Some("call") => expression
            .get("arguments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(expression_names)
            .collect(),
        Some("lambda") => expression
            .get("body")
            .map(expression_names)
            .unwrap_or_default(),
        Some("let") => expression
            .get("value")
            .into_iter()
            .chain(expression.get("body"))
            .flat_map(expression_names)
            .collect(),
        _ => Vec::new(),
    }
}
