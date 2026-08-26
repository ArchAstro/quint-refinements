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
    /// Returns the JSON shape expected in the generated artifact.
    fn artifact_json(&self) -> Value;
    /// Returns the corresponding normalized evaluator value.
    fn runtime_value(&self) -> RuntimeValue;
}

impl QuintFixture for i64 {
    fn artifact_json(&self) -> Value {
        Value::from(*self)
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Int(*self)
    }
}

impl QuintFixture for String {
    fn artifact_json(&self) -> Value {
        Value::String(self.clone())
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Text(self.clone())
    }
}

impl QuintFixture for &str {
    fn artifact_json(&self) -> Value {
        Value::String((*self).to_owned())
    }

    fn runtime_value(&self) -> RuntimeValue {
        RuntimeValue::Text((*self).to_owned())
    }
}

/// Named Quint fixtures backed by Rust values, one namespace per model module.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixtureTable {
    /// Quint module namespace containing these fixture names.
    pub namespace: String,
    values: BTreeMap<String, RuntimeValue>,
    json: BTreeMap<String, Value>,
}

impl FixtureTable {
    /// Creates an empty table for a Quint module namespace.
    #[must_use]
    pub fn new(namespace: impl Into<String>) -> Self {
        Self {
            namespace: namespace.into(),
            values: BTreeMap::new(),
            json: BTreeMap::new(),
        }
    }

    /// Adds one named fixture value.
    #[must_use]
    pub fn insert(mut self, name: &str, fixture: &impl QuintFixture) -> Self {
        self.values.insert(name.to_owned(), fixture.runtime_value());
        self.json.insert(name.to_owned(), fixture.artifact_json());
        self
    }

    /// Adds one named finite set of fixture values.
    #[must_use]
    pub fn insert_set<F: QuintFixture>(mut self, name: &str, members: &[F]) -> Self {
        let mut json_members = members
            .iter()
            .map(QuintFixture::artifact_json)
            .collect::<Vec<_>>();
        json_members.sort_by_key(ToString::to_string);
        let set = members
            .iter()
            .map(QuintFixture::runtime_value)
            .collect::<BTreeSet<_>>();
        self.values.insert(name.to_owned(), RuntimeValue::Set(set));
        self.json
            .insert(name.to_owned(), Value::Array(json_members));
        self
    }

    /// Looks up a fixture by its generated Quint name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&RuntimeValue> {
        self.values.get(name)
    }

    /// Returns whether the table owns a generated Quint name.
    #[must_use]
    pub fn contains_name(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    /// Returns all owned fixture names in deterministic order.
    #[must_use]
    pub fn names(&self) -> Vec<&str> {
        self.values.keys().map(String::as_str).collect()
    }

    /// Returns fixture names in generated retrieve-dependency form.
    #[must_use]
    pub fn retrieve_names(&self) -> Vec<String> {
        self.names()
            .into_iter()
            .map(|name| format!("name:{name}"))
            .collect()
    }

    /// Owned entries must exist in the artifact with matching JSON. Extra
    /// artifact fixtures (other records in the same Quint module) are allowed.
    /// Record comparison is key-subset: Rust keys must exist on the Quint
    /// object with equal values, so `organization_id` vs `org_id` fails.
    pub fn validate_entries(&self, artifact: &ConformanceArtifact) -> Result<(), Error> {
        let Some(expected) = artifact.fixtures.get(&self.namespace) else {
            return Err(Error::new(format!(
                "fixture namespace {} is missing from the artifact",
                self.namespace
            )));
        };
        for (name, rust_json) in &self.json {
            let Some(artifact_json) = expected.get(name) else {
                return Err(Error::new(format!(
                    "artifact namespace {} is missing fixture {name}",
                    self.namespace
                )));
            };
            if !fixture_json_matches(rust_json, artifact_json) {
                return Err(Error::new(format!(
                    "fixture {name} JSON diverged: artifact {artifact_json} rust {rust_json}"
                )));
            }
        }
        Ok(())
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
            if !fixture_json_equal(rust_json, artifact_json) {
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
    /// Stable model fixtures resolved before live evidence.
    pub fixtures: &'a FixtureTable,
    /// Live implementation snapshot.
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

fn set_json_equal(left: &[Value], right: &[Value]) -> bool {
    let mut left_sorted = left.to_vec();
    let mut right_sorted = right.to_vec();
    left_sorted.sort_by_key(ToString::to_string);
    right_sorted.sort_by_key(ToString::to_string);
    left_sorted == right_sorted
}

pub(crate) fn fixture_json_matches(rust: &Value, artifact: &Value) -> bool {
    if rust == artifact {
        return true;
    }
    match (rust, artifact) {
        (Value::Array(rust_set), Value::Object(artifact_object)) => artifact_object
            .get("#set")
            .and_then(Value::as_array)
            .is_some_and(|artifact_set| set_json_equal(rust_set, artifact_set)),
        (Value::Object(rust_object), Value::Object(artifact_object)) => {
            rust_object.iter().all(|(key, value)| {
                artifact_object
                    .get(key)
                    .is_some_and(|artifact_value| fixture_json_matches(value, artifact_value))
            })
        }
        _ => false,
    }
}

fn fixture_json_equal(rust: &Value, artifact: &Value) -> bool {
    if rust == artifact {
        return true;
    }
    match (rust, artifact) {
        (Value::Array(rust_set), Value::Object(artifact_object)) => artifact_object
            .get("#set")
            .and_then(Value::as_array)
            .is_some_and(|artifact_set| set_json_equal(rust_set, artifact_set)),
        (Value::Object(rust_object), Value::Object(artifact_object)) => {
            rust_object.len() == artifact_object.len()
                && rust_object.iter().all(|(key, value)| {
                    artifact_object
                        .get(key)
                        .is_some_and(|artifact_value| fixture_json_equal(value, artifact_value))
                })
        }
        _ => false,
    }
}

pub(crate) fn expression_names(expression: &Value) -> Vec<String> {
    expression_names_bound(expression, &BTreeSet::new())
}

fn expression_names_bound(expression: &Value, bound: &BTreeSet<String>) -> Vec<String> {
    match expression["kind"].as_str() {
        Some("name") => expression["value"]
            .as_str()
            .filter(|name| !bound.contains(*name))
            .map(|name| vec![name.to_owned()])
            .unwrap_or_default(),
        Some("call") => expression
            .get("arguments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|argument| expression_names_bound(argument, bound))
            .collect(),
        Some("lambda") => {
            let mut nested = bound.clone();
            if let Some(parameters) = expression.get("parameters").and_then(Value::as_array) {
                for parameter in parameters {
                    if let Some(name) = parameter.as_str() {
                        nested.insert(name.to_owned());
                    }
                }
            }
            expression
                .get("body")
                .map(|body| expression_names_bound(body, &nested))
                .unwrap_or_default()
        }
        Some("let") => {
            let mut nested = bound.clone();
            if let Some(name) = expression["name"].as_str() {
                nested.insert(name.to_owned());
            }
            expression
                .get("value")
                .into_iter()
                .flat_map(|value| expression_names_bound(value, bound))
                .chain(
                    expression
                        .get("body")
                        .into_iter()
                        .flat_map(|body| expression_names_bound(body, &nested)),
                )
                .collect()
        }
        _ => Vec::new(),
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
