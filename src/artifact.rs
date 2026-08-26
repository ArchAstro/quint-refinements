use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::Error;

/// Frozen schema-v2 conformance artifact exported from the Quint model.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConformanceArtifact {
    /// Version of the generated artifact schema.
    pub schema_version: u32,
    /// Digest of the Quint model inputs used during generation.
    pub model_digest: String,
    /// Closed action, capability, expression, and observation vocabulary.
    pub vocabulary: ArtifactVocabulary,
    /// Generated fixture values keyed by model namespace and fixture name.
    pub fixtures: BTreeMap<String, BTreeMap<String, Value>>,
    /// Ordered scenarios generated from model runs.
    pub scenarios: Vec<ArtifactScenario>,
}

impl ConformanceArtifact {
    /// Parses the checked JSON artifact without interpreting Quint source.
    pub fn parse(json: &str) -> Result<Self, Error> {
        let artifact: Self = serde_json::from_str(json)
            .map_err(|error| Error::new(format!("invalid refinement artifact: {error}")))?;
        let expected_operators: Vec<String> = serde_json::from_str(include_str!(
            "../expression_vocabulary.json"
        ))
        .map_err(|error| Error::new(format!("invalid embedded expression vocabulary: {error}")))?;
        let has_complete_refinement = artifact
            .scenarios
            .iter()
            .any(|scenario| scenario.initial_state.is_some());
        if has_complete_refinement
            && artifact.vocabulary.refinement_expression_operators != expected_operators
        {
            return Err(Error::new(
                "artifact refinement expression vocabulary differs from the Rust evaluator",
            ));
        }
        Ok(artifact)
    }
}

/// Closed vocabulary published by the trace generator.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactVocabulary {
    /// Model actions present in the artifact.
    pub actions: Vec<String>,
    /// Capabilities required by one or more scenarios.
    pub capabilities: Vec<String>,
    /// Operators used by compatibility-mode runtime expressions.
    pub expression_operators: Vec<String>,
    /// Names used by compatibility-mode runtime expressions.
    pub expression_names: Vec<String>,
    #[serde(default)]
    /// Operators accepted by complete refinement expressions.
    pub refinement_expression_operators: Vec<String>,
    /// Runtime observation dependencies used by generated assertions.
    pub runtime_observation_dependencies: Vec<String>,
    /// Digest of the runtime observation dependency vocabulary.
    pub runtime_observation_dependency_digest: String,
}

/// One ordered conformance scenario.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactScenario {
    /// Quint source file that defined the run.
    pub source: String,
    /// Quint module that defined the run.
    pub module: String,
    /// Namespace used to resolve generated fixtures.
    pub fixture_namespace: String,
    /// Run name within the Quint module.
    pub name: String,
    /// Capabilities required to execute this scenario.
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    /// Complete generated initial model state, when full refinement is enabled.
    pub initial_state: Option<Value>,
    /// Ordered initialization, action, and observation steps.
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
    /// Initializer step that precedes all implementation actions.
    Init {
        /// Zero-based position in the generated scenario.
        index: usize,
        /// Initializer action name.
        action: String,
        /// Concrete arguments generated for the initializer.
        arguments: Vec<Value>,
    },
    /// Model action owned by an implementation primitive.
    Action {
        /// Zero-based position in the generated scenario.
        index: usize,
        /// Model action name.
        action: String,
        /// Concrete arguments generated for the action.
        arguments: Vec<Value>,
        #[serde(default)]
        /// Predicates evaluated against the preceding snapshot.
        guards: Vec<ArtifactAssertion>,
        #[serde(default)]
        /// Next-state predicates evaluated across the preceding and resulting snapshots.
        next: Vec<ArtifactAssertion>,
    },
    /// Observation-only step evaluated against the current snapshot.
    Observe {
        /// Zero-based position in the generated scenario.
        index: usize,
        /// Observation assertions emitted by the generator.
        assertions: Vec<ArtifactAssertion>,
    },
}

/// Assertion provenance and normalized dependencies exported by the generator.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAssertion {
    /// Whether the assertion is part of complete model refinement or a runtime adapter.
    pub scope: AssertionScope,
    /// Normalized expression tree interpreted by the evaluator.
    pub expression: Value,
    #[serde(default)]
    /// Names, calls, and paths required to evaluate this assertion.
    pub dependencies: Vec<String>,
}

/// Whether an assertion is evaluated by a runtime adapter or only by Quint.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AssertionScope {
    /// Assertion supplied by a runtime observation adapter.
    Runtime,
    /// Assertion extracted directly from the model action.
    Model,
}
