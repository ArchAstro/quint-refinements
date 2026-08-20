use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::Error;

/// Frozen schema-v2 conformance artifact exported from the Quint model.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConformanceArtifact {
    pub schema_version: u32,
    pub model_digest: String,
    pub vocabulary: ArtifactVocabulary,
    pub fixtures: BTreeMap<String, BTreeMap<String, Value>>,
    pub scenarios: Vec<ArtifactScenario>,
}

impl ConformanceArtifact {
    /// Parses the checked JSON artifact without interpreting Quint source.
    pub fn parse(json: &str) -> Result<Self, Error> {
        serde_json::from_str(json)
            .map_err(|error| Error::new(format!("invalid refinement artifact: {error}")))
    }
}

/// Closed vocabulary published by Q12.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactVocabulary {
    pub actions: Vec<String>,
    pub capabilities: Vec<String>,
    pub expression_operators: Vec<String>,
    pub expression_names: Vec<String>,
    pub runtime_observation_dependencies: Vec<String>,
    pub runtime_observation_dependency_digest: String,
}

/// One ordered conformance scenario.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactScenario {
    pub source: String,
    pub module: String,
    pub fixture_namespace: String,
    pub name: String,
    pub required_capabilities: Vec<String>,
    pub steps: Vec<ArtifactStep>,
}

impl ArtifactScenario {
    /// Stable scenario identifier used by the coverage report.
    #[must_use]
    pub fn id(&self) -> String {
        format!("{}.{}", self.module, self.name)
    }
}

/// Closed subset of scenario steps needed for eligibility validation.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ArtifactStep {
    Init {
        index: usize,
        action: String,
        arguments: Vec<Value>,
    },
    Action {
        index: usize,
        action: String,
        arguments: Vec<Value>,
        #[serde(default)]
        guards: Vec<ArtifactAssertion>,
        #[serde(default)]
        next: Vec<ArtifactAssertion>,
    },
    Observe {
        index: usize,
        assertions: Vec<ArtifactAssertion>,
    },
}

/// Assertion provenance and normalized dependencies exported by Q12.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAssertion {
    pub scope: AssertionScope,
    pub expression: Value,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

/// Whether an assertion is evaluated by a runtime adapter or only by Quint.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AssertionScope {
    Runtime,
    Model,
}
