use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::Error;

/// Oldest artifact schema this crate reads: guards and next-state obligations
/// are written inline on every step.
const FIRST_SUPPORTED_SCHEMA: u32 = 2;
/// Newest artifact schema this crate reads: steps name shared obligation lists
/// by index into the artifact's `assertionLists`.
const LATEST_SCHEMA: u32 = 3;

/// Conformance artifact exported from the Quint model (schema v2 or v3).
///
/// Schema v3 stores each distinct list of obligations once in
/// `assertionLists` and a step names its `guardList` and `nextList` by index.
/// Loading resolves those references, so every step carries its own `guards`
/// and `next` whichever schema the file used.
#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "RawConformanceArtifact")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawConformanceArtifact {
    schema_version: u32,
    model_digest: String,
    vocabulary: ArtifactVocabulary,
    fixtures: BTreeMap<String, BTreeMap<String, Value>>,
    #[serde(default)]
    assertion_lists: Option<Vec<Vec<ArtifactAssertion>>>,
    scenarios: Vec<RawScenario>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawScenario {
    source: String,
    module: String,
    fixture_namespace: String,
    name: String,
    required_capabilities: Vec<String>,
    #[serde(default)]
    initial_state: Option<Value>,
    steps: Vec<RawStep>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum RawStep {
    Init {
        index: usize,
        action: String,
        arguments: Vec<Value>,
    },
    #[serde(rename_all = "camelCase")]
    Action {
        index: usize,
        action: String,
        arguments: Vec<Value>,
        #[serde(default)]
        guards: Option<Vec<ArtifactAssertion>>,
        #[serde(default)]
        next: Option<Vec<ArtifactAssertion>>,
        #[serde(default)]
        guard_list: Option<usize>,
        #[serde(default)]
        next_list: Option<usize>,
    },
    Observe {
        index: usize,
        assertions: Vec<ArtifactAssertion>,
    },
}

impl TryFrom<RawConformanceArtifact> for ConformanceArtifact {
    type Error = String;

    fn try_from(raw: RawConformanceArtifact) -> Result<Self, String> {
        let version = raw.schema_version;
        if !(FIRST_SUPPORTED_SCHEMA..=LATEST_SCHEMA).contains(&version) {
            return Err(format!(
                "unsupported schema version {version}; this runtime reads versions \
                 {FIRST_SUPPORTED_SCHEMA} to {LATEST_SCHEMA}"
            ));
        }
        let shared = version >= 3;
        if !shared && raw.assertion_lists.is_some() {
            return Err(format!(
                "`assertionLists` needs schema version 3, found {version}"
            ));
        }
        let lists = raw.assertion_lists.unwrap_or_default();
        let resolve = |reference: usize, field: &str| -> Result<Vec<ArtifactAssertion>, String> {
            lists.get(reference).cloned().ok_or_else(|| {
                format!(
                    "`{field}` {reference} is out of range: the artifact has {} assertion lists",
                    lists.len()
                )
            })
        };
        let mut scenarios = Vec::with_capacity(raw.scenarios.len());
        for scenario in raw.scenarios {
            let mut steps = Vec::with_capacity(scenario.steps.len());
            for step in scenario.steps {
                steps.push(match step {
                    RawStep::Init {
                        index,
                        action,
                        arguments,
                    } => ArtifactStep::Init {
                        index,
                        action,
                        arguments,
                    },
                    RawStep::Observe { index, assertions } => {
                        ArtifactStep::Observe { index, assertions }
                    }
                    RawStep::Action {
                        index,
                        action,
                        arguments,
                        guards,
                        next,
                        guard_list,
                        next_list,
                    } => {
                        if shared && (guards.is_some() || next.is_some()) {
                            return Err(format!(
                                "step {index} of {}.{} has inline `guards` or `next`; \
                                 schema version {version} names them with `guardList` and `nextList`",
                                scenario.module, scenario.name
                            ));
                        }
                        if !shared && (guard_list.is_some() || next_list.is_some()) {
                            return Err(format!(
                                "step {index} of {}.{} uses `guardList` or `nextList`, \
                                 which need schema version 3, found {version}",
                                scenario.module, scenario.name
                            ));
                        }
                        let guards = match guard_list {
                            Some(reference) => resolve(reference, "guardList")?,
                            None => guards.unwrap_or_default(),
                        };
                        let next = match next_list {
                            Some(reference) => resolve(reference, "nextList")?,
                            None => next.unwrap_or_default(),
                        };
                        ArtifactStep::Action {
                            index,
                            action,
                            arguments,
                            guards,
                            next,
                        }
                    }
                });
            }
            scenarios.push(ArtifactScenario {
                source: scenario.source,
                module: scenario.module,
                fixture_namespace: scenario.fixture_namespace,
                name: scenario.name,
                required_capabilities: scenario.required_capabilities,
                initial_state: scenario.initial_state,
                steps,
            });
        }
        Ok(Self {
            schema_version: version,
            model_digest: raw.model_digest,
            vocabulary: raw.vocabulary,
            fixtures: raw.fixtures,
            scenarios,
        })
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
