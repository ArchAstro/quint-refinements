use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::artifact::{ArtifactAssertion, ArtifactScenario, ArtifactStep, AssertionScope};

/// A normalized Quint value reconstructed from runtime-owned evidence.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum RuntimeValue {
    /// Boolean value.
    Bool(bool),
    /// Signed integer value.
    Int(i64),
    /// Text value or unit constructor name.
    Text(String),
    /// Structurally keyed set.
    Set(BTreeSet<Self>),
    /// Ordered list.
    List(Vec<Self>),
    /// Fixed-position tuple.
    Tuple(Vec<Self>),
    /// Map whose keys and values retain their Quint structure.
    Map(BTreeMap<Self, Self>),
    /// Record keyed by field name.
    Record(BTreeMap<String, Self>),
    /// Tagged union value.
    Variant {
        /// Constructor tag.
        tag: String,
        /// Constructor payload.
        value: Box<Self>,
    },
    /// Quint `Absent` option.
    Absent,
    /// Quint `Present` option and its value.
    Present(Box<Self>),
}

impl RuntimeValue {
    /// Builds a normalized set of text values.
    #[must_use]
    pub fn text_set<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::Set(
            values
                .into_iter()
                .map(|value| Self::Text(value.into()))
                .collect(),
        )
    }

    /// Decodes Quint's Informal Trace Format value without collapsing maps,
    /// records, tuples, sets, or variants into one another.
    pub fn from_itf_json(value: &serde_json::Value) -> Result<Self, String> {
        match value {
            serde_json::Value::Bool(value) => Ok(Self::Bool(*value)),
            serde_json::Value::String(value) => Ok(Self::Text(value.clone())),
            serde_json::Value::Number(value) => value
                .as_i64()
                .map(Self::Int)
                .ok_or_else(|| format!("ITF number is outside normalized integer range: {value}")),
            serde_json::Value::Array(values) => values
                .iter()
                .map(Self::from_itf_json)
                .collect::<Result<Vec<_>, _>>()
                .map(Self::List),
            serde_json::Value::Object(object) => {
                if let Some(value) = object.get("#bigint") {
                    return value
                        .as_str()
                        .ok_or_else(|| "ITF #bigint is not text".to_owned())?
                        .parse::<i64>()
                        .map(Self::Int)
                        .map_err(|error| format!("ITF #bigint is outside i64: {error}"));
                }
                if let Some(values) = object.get("#tup") {
                    return decode_itf_values(values, "#tup").map(Self::Tuple);
                }
                if let Some(values) = object.get("#set") {
                    return decode_itf_values(values, "#set")
                        .map(|values| Self::Set(values.into_iter().collect()));
                }
                if let Some(entries) = object.get("#map") {
                    let entries = entries
                        .as_array()
                        .ok_or_else(|| "ITF #map is not an array".to_owned())?;
                    let mut decoded = BTreeMap::new();
                    for entry in entries {
                        let pair = entry
                            .as_array()
                            .ok_or_else(|| "ITF #map entry is not an array".to_owned())?;
                        let [key, value] = pair.as_slice() else {
                            return Err("ITF #map entry is not a key/value pair".to_owned());
                        };
                        decoded.insert(Self::from_itf_json(key)?, Self::from_itf_json(value)?);
                    }
                    return Ok(Self::Map(decoded));
                }
                if object.len() == 2 && object.contains_key("tag") && object.contains_key("value") {
                    let tag = object["tag"]
                        .as_str()
                        .ok_or_else(|| "ITF variant tag is not text".to_owned())?;
                    let value = Self::from_itf_json(&object["value"])?;
                    return match (tag, value) {
                        ("Absent", _) => Ok(Self::Absent),
                        ("Present", value) => Ok(Self::Present(Box::new(value))),
                        (tag, Self::Tuple(values)) if values.is_empty() => {
                            Ok(Self::Text(tag.to_owned()))
                        }
                        (tag, value) => Ok(Self::Variant {
                            tag: tag.to_owned(),
                            value: Box::new(value),
                        }),
                    };
                }
                object
                    .iter()
                    .filter(|(key, _)| *key != "#meta" && !key.starts_with("__"))
                    .map(|(key, value)| Ok((key.clone(), Self::from_itf_json(value)?)))
                    .collect::<Result<BTreeMap<_, _>, _>>()
                    .map(Self::Record)
            }
            serde_json::Value::Null => Err("ITF null has no Quint runtime value".to_owned()),
        }
    }
}

fn decode_itf_values(value: &serde_json::Value, kind: &str) -> Result<Vec<RuntimeValue>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("ITF {kind} is not an array"))?
        .iter()
        .map(RuntimeValue::from_itf_json)
        .collect()
}

/// Resolves domain-specific names and calls used by refinement expressions.
///
/// The shared evaluator owns the normalized expression grammar. Implementors
/// expose only evidence that is specific to one runtime scenario family.
pub trait NormalizedRuntimeEvidence {
    /// Resolves a generated name such as `state` to its observed value.
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String>;

    /// Resolves an optional domain-specific call, or returns `None` for built-in evaluation.
    fn resolve_call(
        &self,
        operator: &str,
        arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>>;
}

/// Resolve one generated action's Quint arguments against hydrated Rust
/// fixtures and the current scenario state.
pub fn evaluate_action_arguments(
    step: &ArtifactStep,
    evidence: &impl NormalizedRuntimeEvidence,
) -> Result<Vec<RuntimeValue>, String> {
    let ArtifactStep::Action {
        action, arguments, ..
    } = step
    else {
        return Err("only action steps have runtime arguments".to_owned());
    };
    let eval = Eval {
        current: evidence,
        before: evidence,
        after: evidence,
        assignment_sink: None,
    };
    arguments
        .iter()
        .map(|argument| {
            evaluate_expression(argument, &eval, &BTreeMap::new())
                .map_err(|error| format!("{action} argument: {error}"))
        })
        .collect()
}

/// Evaluates every non-model assertion in a checked scenario.
///
/// Evaluation fails closed when an assertion references a dependency outside
/// the adapter's declared registry or uses unsupported normalized syntax.
pub fn evaluate_runtime_assertions(
    scenario: &ArtifactScenario,
    evidence: &impl NormalizedRuntimeEvidence,
    supported_dependencies: &[&str],
) -> Result<usize, String> {
    let mut evaluated = 0;

    for step in &scenario.steps {
        let ArtifactStep::Observe { assertions, .. } = step else {
            continue;
        };
        let eval = Eval {
            current: evidence,
            before: evidence,
            after: evidence,
            assignment_sink: None,
        };
        evaluated += evaluate_assertions(
            &scenario.id(),
            "observe",
            assertions,
            &eval,
            supported_dependencies,
            true,
        )?;
    }

    if evaluated == 0 {
        return Err(format!("{} evaluated no runtime assertions", scenario.id()));
    }
    Ok(evaluated)
}

/// Evaluates guard assertions on the retrieve-before snapshot and next-state
/// assertions on the retrieve-after snapshot for one action step.
///
/// Model-scope conjuncts are skipped. Prefer [`evaluate_all_step_obligations`]
/// once the scenario's Quint names have Rust fixture owners.
pub fn evaluate_step_obligations<E: NormalizedRuntimeEvidence>(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    before: &E,
    after: &E,
    retrieve: &[&str],
) -> Result<usize, String> {
    evaluate_step_obligations_inner(
        scenario_id,
        action,
        guards,
        next,
        before,
        after,
        retrieve,
        true,
    )
}

/// Evaluates each Observe chapter's preceding action `next` against the same
/// evidence used for that Observe. Last-writer next is a copy of the chapter's
/// runtime assertions, so this is the generated step check every runner can
/// execute without mid-action snapshots.
pub fn evaluate_chapter_next(
    scenario: &ArtifactScenario,
    evidence: &impl NormalizedRuntimeEvidence,
    retrieve: &[&str],
) -> Result<usize, String> {
    let mut evaluated = 0;
    for (index, step) in scenario.steps.iter().enumerate() {
        if matches!(step, ArtifactStep::Observe { .. }) {
            evaluated += evaluate_preceding_action_next(scenario, index, evidence, retrieve)?;
        }
    }
    Ok(evaluated)
}

/// Evaluates `next` on the last action before `observe_index`.
pub fn evaluate_preceding_action_next(
    scenario: &ArtifactScenario,
    observe_index: usize,
    evidence: &impl NormalizedRuntimeEvidence,
    retrieve: &[&str],
) -> Result<usize, String> {
    let Some(ArtifactStep::Action { action, next, .. }) = scenario.steps[..observe_index]
        .iter()
        .rev()
        .find(|step| matches!(step, ArtifactStep::Action { .. }))
    else {
        return Ok(0);
    };
    if next.is_empty() {
        return Ok(0);
    }
    evaluate_step_obligations(
        &scenario.id(),
        action,
        &[],
        next,
        evidence,
        evidence,
        retrieve,
    )
}

/// Strict fake-domain loop: `snapshots[0]` is retrieve-before the first action;
/// `snapshots[i + 1]` is retrieve-after action `i`. Fails if the snapshot
/// count is not action count plus one.
pub fn evaluate_every_action_step<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
) -> Result<usize, String> {
    evaluate_action_steps(scenario, snapshots, retrieve, true)
}

/// Like [`evaluate_every_action_step`], but every guard and next conjunct
/// runs. Fixture-backed names belong on `retrieve` as `name:<fixture>`.
pub fn evaluate_all_action_steps<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
) -> Result<usize, String> {
    evaluate_action_steps(scenario, snapshots, retrieve, false)
}

/// Evaluate a complete scenario as a reducer over its generated action tape.
///
/// The generated Quint initial state is hydrated once into [`RuntimeValue`].
/// Each generated action assignment advances that hydrated state; Rust action
/// evidence overlays only the state fields claimed by the retrieve contract.
/// Pre-guards evaluate before the assignment and Rust action, while assignment
/// guards and every `next` conjunct evaluate against the merged state after it.
/// Rust therefore implements reusable actions, not handwritten scenarios or a
/// second copy of Quint's state-transition logic.
pub fn evaluate_projected_action_steps<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
) -> Result<usize, String> {
    evaluate_projected_action_steps_inner(scenario, snapshots, retrieve, true)
        .map(|(evaluated, _)| evaluated)
}

/// Evaluate final scenario observations against the same accumulated state
/// produced by the action reducer.
pub fn evaluate_projected_runtime_assertions<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    supported_dependencies: &[&str],
) -> Result<usize, String> {
    let action_total = scenario
        .steps
        .iter()
        .filter(|step| matches!(step, ArtifactStep::Action { .. }))
        .count();
    if snapshots.len() != action_total + 1 {
        return Err(format!(
            "{} has {action_total} actions but {} snapshots",
            scenario.id(),
            snapshots.len()
        ));
    }
    let mut action_count = 0;
    let mut evaluated = 0;
    for step in &scenario.steps {
        match step {
            ArtifactStep::Action { .. } => action_count += 1,
            ArtifactStep::Observe { .. } => {
                let state = evaluate_projected_prefix_state(
                    scenario,
                    &snapshots[..=action_count],
                    retrieve,
                    action_count,
                )?;
                let mut chapter = scenario.clone();
                chapter.steps = vec![step.clone()];
                evaluated += evaluate_runtime_assertions(
                    &chapter,
                    &ProjectedEvidence {
                        snapshot: &snapshots[action_count],
                        state,
                    },
                    supported_dependencies,
                )?;
            }
            ArtifactStep::Init { .. } => {}
        }
    }
    if evaluated == 0 {
        return Err(format!("{} evaluated no runtime assertions", scenario.id()));
    }
    Ok(evaluated)
}

pub(crate) fn evaluate_projected_prefix_state<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    action_count: usize,
) -> Result<RuntimeValue, String> {
    let mut prefix = scenario.clone();
    let mut retained_actions = 0;
    prefix.steps.retain(|step| match step {
        ArtifactStep::Init { .. } => true,
        ArtifactStep::Action { .. } if retained_actions < action_count => {
            retained_actions += 1;
            true
        }
        ArtifactStep::Action { .. } | ArtifactStep::Observe { .. } => false,
    });
    evaluate_projected_action_steps_inner(&prefix, snapshots, retrieve, false)
        .map(|(_, state)| state)
}

pub(crate) fn evaluate_projected_pre_guards<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    action_index: usize,
    state: &RuntimeValue,
    snapshot: &E,
    retrieve: &[&str],
) -> Result<usize, String> {
    let (action, guards) = scenario
        .steps
        .iter()
        .filter_map(|step| match step {
            ArtifactStep::Action { action, guards, .. } => Some((action, guards)),
            ArtifactStep::Init { .. } | ArtifactStep::Observe { .. } => None,
        })
        .nth(action_index)
        .ok_or_else(|| format!("{} has no action {action_index}", scenario.id()))?;
    let pre_guards = guards
        .iter()
        .filter(|assertion| !contains_assignment(&assertion.expression))
        .cloned()
        .collect::<Vec<_>>();
    let before = ProjectedEvidence {
        snapshot,
        state: state.clone(),
    };
    let eval = Eval {
        current: &before,
        before: &before,
        after: &before,
        assignment_sink: None,
    };
    let context = format!("{}:{action}", scenario.id());
    evaluate_assertions(&context, "pre-guard", &pre_guards, &eval, retrieve, false)
}

fn evaluate_projected_action_steps_inner<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    require_obligations: bool,
) -> Result<(usize, RuntimeValue), String> {
    let actions = scenario
        .steps
        .iter()
        .filter_map(|step| match step {
            ArtifactStep::Action {
                action,
                guards,
                next,
                ..
            } => Some((action.as_str(), guards.as_slice(), next.as_slice())),
            _ => None,
        })
        .collect::<Vec<_>>();
    if snapshots.len() != actions.len() + 1 {
        return Err(format!(
            "{} has {} actions but {} snapshots (want init plus one after each action)",
            scenario.id(),
            actions.len(),
            snapshots.len()
        ));
    }
    let initial = scenario
        .initial_state
        .as_ref()
        .ok_or_else(|| format!("{} has no complete initial state", scenario.id()))?;
    let mut state = RuntimeValue::from_itf_json(initial)
        .map_err(|error| format!("{} initial state: {error}", scenario.id()))?;
    let initial_observed = snapshots[0]
        .resolve_name("state")
        .map_err(|error| format!("{} init state evidence: {error}", scenario.id()))?;
    if !structurally_equal(&state, &initial_observed) {
        return Err(format!(
            "{} Rust fixture does not match Quint initial state: {}",
            scenario.id(),
            structural_difference(&state, &initial_observed, "state")
                .unwrap_or_else(|| "normalized values differ".to_owned())
        ));
    }
    let mut evaluated = 0;

    for (index, (action, guards, next)) in actions.iter().enumerate() {
        let step = evaluate_projected_action_step(
            &scenario.id(),
            action,
            guards,
            next,
            &state,
            &snapshots[index],
            &snapshots[index + 1],
            retrieve,
        )?;
        evaluated += step.0;
        state = step.1;
    }

    if require_obligations && evaluated == 0 {
        return Err(format!("{} evaluated no action obligations", scenario.id()));
    }
    Ok((evaluated, state))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate_projected_action_step<E: NormalizedRuntimeEvidence>(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    state: &RuntimeValue,
    before_snapshot: &E,
    after_snapshot: &E,
    retrieve: &[&str],
) -> Result<(usize, RuntimeValue), String> {
    let context = format!("{scenario_id}:{action}");
    let before = ProjectedEvidence {
        snapshot: before_snapshot,
        state: state.clone(),
    };
    let pre_guards = guards
        .iter()
        .filter(|assertion| !contains_assignment(&assertion.expression))
        .cloned()
        .collect::<Vec<_>>();
    let guard_eval = Eval {
        current: &before,
        before: &before,
        after: &before,
        assignment_sink: None,
    };
    let mut evaluated = evaluate_assertions(
        &context,
        "pre-guard",
        &pre_guards,
        &guard_eval,
        retrieve,
        false,
    )?;

    let assignment = RefCell::new(None);
    let capture_eval = Eval {
        current: &before,
        before: &before,
        after: &before,
        assignment_sink: Some(&assignment),
    };
    let (assignment_kind, assignment_assertion) = guards
        .iter()
        .find(|assertion| contains_assignment(&assertion.expression))
        .map(|assertion| ("post-guard", assertion))
        .or_else(|| {
            next.iter()
                .find(|assertion| contains_assignment(&assertion.expression))
                .map(|assertion| ("next", assertion))
        })
        .ok_or_else(|| format!("{context} next: complete action has no state assignment"))?;
    evaluate_assertions(
        &context,
        assignment_kind,
        std::slice::from_ref(assignment_assertion),
        &capture_eval,
        retrieve,
        false,
    )?;
    let model_next = assignment
        .into_inner()
        .ok_or_else(|| format!("{context} next: complete action has no state assignment"))?;
    let observed = after_snapshot
        .resolve_name("state")
        .map_err(|error| format!("{context} state evidence: {error}"))?;
    let action_observed_fields = guards
        .iter()
        .chain(next.iter())
        .filter(|assertion| assertion.scope == AssertionScope::Runtime)
        .flat_map(|assertion| assertion.dependencies.iter())
        .filter_map(|dependency| dependency.strip_prefix("path:state."))
        .filter_map(|path| path.split('.').next())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    require_changed_observations(state, &model_next, &observed, &action_observed_fields)
        .map_err(|error| format!("{context} state evidence: {error}"))?;
    let mut merged_fields = observed_state_fields(retrieve);
    merged_fields.extend(action_observed_fields);
    let merged = merge_observed_state(model_next, &observed, &merged_fields)?;
    let after = ProjectedEvidence {
        snapshot: after_snapshot,
        state: merged.clone(),
    };
    let post_guards = guards
        .iter()
        .filter(|assertion| contains_assignment(&assertion.expression))
        .cloned()
        .collect::<Vec<_>>();
    let next_eval = Eval {
        current: &after,
        before: &before,
        after: &after,
        assignment_sink: None,
    };
    let post_guard_eval = Eval {
        current: &before,
        before: &before,
        after: &after,
        assignment_sink: None,
    };
    evaluated += evaluate_assertions(
        &context,
        "post-guard",
        &post_guards,
        &post_guard_eval,
        retrieve,
        false,
    )?;
    evaluated += evaluate_assertions(&context, "next", next, &next_eval, retrieve, false)?;
    Ok((evaluated, merged))
}

struct ProjectedEvidence<'a, E> {
    snapshot: &'a E,
    state: RuntimeValue,
}

impl<E: NormalizedRuntimeEvidence> NormalizedRuntimeEvidence for ProjectedEvidence<'_, E> {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        if name == "state" {
            Ok(self.state.clone())
        } else {
            self.snapshot.resolve_name(name)
        }
    }

    fn resolve_call(
        &self,
        operator: &str,
        arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        if let ("dedupEntry", [key]) = (operator, arguments) {
            return Some(projected_optional_map_value(
                &self.state,
                "connector_dedup",
                key,
            ));
        }
        if let ("dedupValue", [key]) = (operator, arguments) {
            return Some(
                projected_optional_map_value(&self.state, "connector_dedup", key).and_then(
                    |value| match value {
                        RuntimeValue::Present(value) => Ok(*value),
                        RuntimeValue::Absent => {
                            Err("projected connector_dedup entry is absent".to_owned())
                        }
                        value => Ok(value),
                    },
                ),
            );
        }
        if let ("resultFor", [RuntimeValue::Record(delivery), outcome]) = (operator, arguments) {
            let field = |name: &str| {
                delivery
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("deliveryValue has no {name}"))
            };
            return Some((|| {
                Ok(RuntimeValue::Record(BTreeMap::from([
                    ("attempt_id".to_owned(), field("attempt_id")?),
                    ("delivery_id".to_owned(), field("id")?),
                    ("org_id".to_owned(), field("org_id")?),
                    ("service_spec_id".to_owned(), field("service_spec_id")?),
                    ("service_id".to_owned(), field("service_id")?),
                    ("connection_id".to_owned(), field("connection_id")?),
                    ("outcome".to_owned(), outcome.clone()),
                ])))
            })());
        }
        let field = match operator {
            "attemptValue" => Some("attempts"),
            "connectionValue" => Some("connections"),
            "deliveryValue" => Some("deliveries"),
            "tokenValue" => Some("enrollment_tokens"),
            _ => None,
        };
        if let (Some(field), [key]) = (field, arguments) {
            return Some(projected_map_value(&self.state, field, key));
        }
        self.snapshot.resolve_call(operator, arguments)
    }
}

fn projected_optional_map_value(
    state: &RuntimeValue,
    field: &str,
    key: &RuntimeValue,
) -> Result<RuntimeValue, String> {
    let RuntimeValue::Record(state) = state else {
        return Err("projected state is not a record".to_owned());
    };
    let Some(RuntimeValue::Map(values)) = state.get(field) else {
        return Err(format!("projected state has no map {field}"));
    };
    Ok(values.get(key).cloned().unwrap_or(RuntimeValue::Absent))
}

fn projected_map_value(
    state: &RuntimeValue,
    field: &str,
    key: &RuntimeValue,
) -> Result<RuntimeValue, String> {
    let RuntimeValue::Record(state) = state else {
        return Err("projected state is not a record".to_owned());
    };
    let value = match (state.get(field), key) {
        (Some(RuntimeValue::Map(values)), key) => values.get(key),
        (Some(RuntimeValue::Record(values)), RuntimeValue::Text(key)) => values.get(key),
        _ => return Err(format!("projected state has no keyed collection {field}")),
    };
    match value {
        Some(RuntimeValue::Present(value)) => Ok((**value).clone()),
        Some(RuntimeValue::Absent) | None => {
            Err(format!("projected {field} has no value for {key:?}"))
        }
        Some(value) => Ok(value.clone()),
    }
}

fn observed_state_fields(retrieve: &[&str]) -> BTreeSet<String> {
    retrieve
        .iter()
        .filter_map(|dependency| dependency.strip_prefix("path:state."))
        .filter_map(|path| path.split('.').next())
        .map(str::to_owned)
        .collect()
}

fn contains_assignment(expression: &serde_json::Value) -> bool {
    if expression["kind"].as_str() == Some("call")
        && expression["operator"].as_str() == Some("assign")
    {
        return true;
    }
    match expression {
        serde_json::Value::Array(values) => values.iter().any(contains_assignment),
        serde_json::Value::Object(fields) => fields.values().any(contains_assignment),
        _ => false,
    }
}

fn merge_observed_state(
    model: RuntimeValue,
    observed: &RuntimeValue,
    observed_fields: &BTreeSet<String>,
) -> Result<RuntimeValue, String> {
    let RuntimeValue::Record(mut model_fields) = model else {
        return Err("generated Quint state is not a record".to_owned());
    };
    let RuntimeValue::Record(observed_fields_map) = observed else {
        return Err("Rust action state evidence is not a record".to_owned());
    };
    for field in observed_fields {
        let Some(value) = observed_fields_map.get(field) else {
            continue;
        };
        let Some(model_value) = model_fields.get_mut(field) else {
            return Err(format!(
                "Rust action evidence contains field state.{field} outside the hydrated Quint state"
            ));
        };
        merge_state_value(model_value, value);
    }
    Ok(RuntimeValue::Record(model_fields))
}

fn require_changed_observations(
    before: &RuntimeValue,
    model_next: &RuntimeValue,
    observed: &RuntimeValue,
    observable_fields: &BTreeSet<String>,
) -> Result<(), String> {
    let (RuntimeValue::Record(before), RuntimeValue::Record(model_next)) = (before, model_next)
    else {
        return Err("generated Quint state is not a record".to_owned());
    };
    let RuntimeValue::Record(observed) = observed else {
        return Err("Rust action state evidence is not a record".to_owned());
    };
    for field in observable_fields {
        if before.get(field) != model_next.get(field) && !observed.contains_key(field) {
            return Err(format!(
                "Rust action omitted changed runtime-owned field state.{field}"
            ));
        }
    }
    Ok(())
}

fn merge_state_value(accumulated: &mut RuntimeValue, update: &RuntimeValue) {
    match (accumulated, update) {
        (RuntimeValue::Map(accumulated), RuntimeValue::Map(update)) => {
            for (key, value) in update {
                if let Some(accumulated_value) = accumulated.get_mut(key) {
                    merge_state_value(accumulated_value, value);
                } else {
                    accumulated.insert(key.clone(), value.clone());
                }
            }
        }
        (RuntimeValue::Map(accumulated), RuntimeValue::Record(update)) => {
            for (key, value) in update {
                let key = RuntimeValue::Text(key.clone());
                if let Some(accumulated_value) = accumulated.get_mut(&key) {
                    merge_state_value(accumulated_value, value);
                } else {
                    accumulated.insert(key, value.clone());
                }
            }
        }
        (RuntimeValue::Record(accumulated), RuntimeValue::Record(update)) => {
            for (key, value) in update {
                if let Some(accumulated_value) = accumulated.get_mut(key) {
                    merge_state_value(accumulated_value, value);
                } else {
                    accumulated.insert(key.clone(), value.clone());
                }
            }
        }
        (RuntimeValue::List(accumulated), RuntimeValue::List(update))
        | (RuntimeValue::Tuple(accumulated), RuntimeValue::Tuple(update))
            if accumulated.len() == update.len() =>
        {
            for (accumulated, update) in accumulated.iter_mut().zip(update) {
                merge_state_value(accumulated, update);
            }
        }
        (
            RuntimeValue::Variant {
                tag: accumulated_tag,
                value: accumulated,
            },
            RuntimeValue::Variant {
                tag: update_tag,
                value: update,
            },
        ) if accumulated_tag == update_tag => merge_state_value(accumulated, update),
        (RuntimeValue::Present(accumulated), RuntimeValue::Present(update)) => {
            merge_state_value(accumulated, update);
        }
        (accumulated, update) => *accumulated = update.clone(),
    }
}

/// Evaluates every guard and next conjunct, including model-scope.
pub fn evaluate_all_step_obligations<E: NormalizedRuntimeEvidence>(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    before: &E,
    after: &E,
    retrieve: &[&str],
) -> Result<usize, String> {
    evaluate_step_obligations_inner(
        scenario_id,
        action,
        guards,
        next,
        before,
        after,
        retrieve,
        false,
    )
}

fn evaluate_action_steps<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    skip_model: bool,
) -> Result<usize, String> {
    let actions = scenario
        .steps
        .iter()
        .filter_map(|step| match step {
            ArtifactStep::Action {
                action,
                guards,
                next,
                ..
            } => Some((action.as_str(), guards.as_slice(), next.as_slice())),
            _ => None,
        })
        .collect::<Vec<_>>();
    if snapshots.len() != actions.len() + 1 {
        return Err(format!(
            "{} has {} actions but {} snapshots (want init plus one after each action)",
            scenario.id(),
            actions.len(),
            snapshots.len()
        ));
    }
    let mut evaluated = 0;
    for (index, (action, guards, next)) in actions.iter().enumerate() {
        evaluated += evaluate_step_obligations_inner(
            &scenario.id(),
            action,
            guards,
            next,
            &snapshots[index],
            &snapshots[index + 1],
            retrieve,
            skip_model,
        )?;
    }
    Ok(evaluated)
}

#[allow(clippy::too_many_arguments)]
fn evaluate_step_obligations_inner<E: NormalizedRuntimeEvidence>(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    before: &E,
    after: &E,
    retrieve: &[&str],
    skip_model: bool,
) -> Result<usize, String> {
    if guards.is_empty() && next.is_empty() {
        return Ok(0);
    }
    let context = format!("{scenario_id}:{action}");
    let mut evaluated = 0;
    let guards_eval = Eval {
        current: before,
        before,
        after,
        assignment_sink: None,
    };
    evaluated += evaluate_assertions(
        &context,
        "guard",
        guards,
        &guards_eval,
        retrieve,
        skip_model,
    )?;
    let next_eval = Eval {
        current: after,
        before,
        after,
        assignment_sink: None,
    };
    evaluated += evaluate_assertions(&context, "next", next, &next_eval, retrieve, skip_model)?;
    if evaluated == 0 {
        return Err(format!(
            "{context} declared step obligations but evaluated none"
        ));
    }
    Ok(evaluated)
}

struct Eval<'a, E: NormalizedRuntimeEvidence> {
    current: &'a E,
    before: &'a E,
    after: &'a E,
    assignment_sink: Option<&'a RefCell<Option<RuntimeValue>>>,
}

fn evaluate_assertions<E: NormalizedRuntimeEvidence>(
    context: &str,
    kind: &str,
    assertions: &[ArtifactAssertion],
    eval: &Eval<'_, E>,
    supported_dependencies: &[&str],
    skip_model: bool,
) -> Result<usize, String> {
    let supported = supported_dependencies
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let mut evaluated = 0;
    for assertion in assertions {
        if skip_model && assertion.scope == AssertionScope::Model {
            continue;
        }
        if let Some(dependency) = assertion
            .dependencies
            .iter()
            .find(|dependency| !dependency_is_supported(dependency, &supported))
        {
            return Err(format!(
                "{context} {kind} uses unsupported runtime dependency {dependency}"
            ));
        }
        let value = evaluate_expression(&assertion.expression, eval, &BTreeMap::new())
            .map_err(|error| format!("{context} {kind}: {error}"))?;
        match value {
            RuntimeValue::Bool(true) => evaluated += 1,
            RuntimeValue::Bool(false) => {
                return Err(format!(
                    "{kind} assertion evaluated false in {context}: {}",
                    assertion.expression
                ));
            }
            _ => {
                return Err(format!(
                    "{kind} assertion did not evaluate to boolean in {context}: {}",
                    assertion.expression
                ));
            }
        }
    }
    Ok(evaluated)
}

fn dependency_is_supported(dependency: &str, supported: &BTreeSet<&str>) -> bool {
    matches!(
        dependency,
        "operator:eq"
            | "operator:neq"
            | "operator:not"
            | "operator:actionAll"
            | "operator:contains"
            | "operator:field"
            | "operator:get"
            | "operator:assign"
    ) || supported.contains(dependency)
}

fn evaluate_expression<E: NormalizedRuntimeEvidence>(
    expression: &serde_json::Value,
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    match expression["kind"].as_str() {
        Some("bool") => expression["value"]
            .as_bool()
            .map(RuntimeValue::Bool)
            .ok_or_else(|| "normalized boolean has no value".to_owned()),
        Some("int") => expression["value"]
            .as_i64()
            .map(RuntimeValue::Int)
            .ok_or_else(|| "normalized integer has no value".to_owned()),
        Some("str") => expression["value"]
            .as_str()
            .map(|value| RuntimeValue::Text(value.to_owned()))
            .ok_or_else(|| "normalized string has no value".to_owned()),
        Some("name") => {
            let name = expression["value"]
                .as_str()
                .ok_or_else(|| "normalized name has no value".to_owned())?;
            if let Some(value) = environment.get(name) {
                return Ok(value.clone());
            }
            match name {
                "disabled" => Ok(RuntimeValue::Bool(false)),
                "Absent" => Ok(eval
                    .current
                    .resolve_name(name)
                    .unwrap_or(RuntimeValue::Absent)),
                _ => eval.current.resolve_name(name),
            }
        }
        Some("call") => evaluate_call(expression, eval, environment),
        Some("let") => evaluate_let(expression, eval, environment),
        _ => Err("unsupported normalized expression kind".to_owned()),
    }
}

fn evaluate_let<E: NormalizedRuntimeEvidence>(
    expression: &serde_json::Value,
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let name = expression["name"]
        .as_str()
        .ok_or_else(|| "normalized let has no name".to_owned())?;
    let value = evaluate_expression(&expression["value"], eval, environment)?;
    let mut nested = environment.clone();
    nested.insert(name.to_owned(), value);
    evaluate_expression(&expression["body"], eval, &nested)
}

fn evaluate_call<E: NormalizedRuntimeEvidence>(
    expression: &serde_json::Value,
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let operator = expression["operator"]
        .as_str()
        .ok_or_else(|| "normalized call has no operator".to_owned())?;
    let arguments = expression["arguments"]
        .as_array()
        .ok_or_else(|| "normalized call has no arguments".to_owned())?;
    if operator == "assign" {
        let [left, right] = arguments.as_slice() else {
            return Err("assign requires a variable and an expression".to_owned());
        };
        let expected = evaluate_expression(
            right,
            &Eval {
                current: eval.before,
                before: eval.before,
                after: eval.after,
                assignment_sink: eval.assignment_sink,
            },
            environment,
        )?;
        if let Some(sink) = eval.assignment_sink {
            sink.replace(Some(expected));
            return Ok(RuntimeValue::Bool(true));
        }
        let observed = evaluate_expression(
            left,
            &Eval {
                current: eval.after,
                before: eval.before,
                after: eval.after,
                assignment_sink: eval.assignment_sink,
            },
            environment,
        )?;
        if structurally_equal(&expected, &observed) {
            return Ok(RuntimeValue::Bool(true));
        }
        return Err(format!(
            "assign state diverged at {}",
            structural_difference(&expected, &observed, "state")
                .unwrap_or_else(|| "state".to_owned())
        ));
    }
    if operator == "matchVariant" {
        return evaluate_match_variant(arguments, eval, environment);
    }
    if operator == "filter" {
        return evaluate_filter(arguments, eval, environment);
    }
    if operator == "map" || operator == "mapBy" {
        return evaluate_map(operator, arguments, eval, environment);
    }
    if operator == "fold" {
        return evaluate_fold(arguments, eval, environment);
    }
    if operator == "forall" || operator == "exists" {
        return evaluate_quantifier(operator, arguments, eval, environment);
    }
    if operator == "ite" {
        return evaluate_ite(arguments, eval, environment);
    }
    let values = arguments
        .iter()
        .map(|argument| evaluate_expression(argument, eval, environment))
        .collect::<Result<Vec<_>, _>>()?;

    let common = match (operator, values.as_slice()) {
        ("eq", [left, right]) => Some(Ok(RuntimeValue::Bool(left == right))),
        ("neq", [left, right]) => Some(Ok(RuntimeValue::Bool(left != right))),
        ("not", [RuntimeValue::Bool(value)]) => Some(Ok(RuntimeValue::Bool(!value))),
        ("actionAll", values) => Some(
            values
                .iter()
                .map(|value| match value {
                    RuntimeValue::Bool(value) => Ok(*value),
                    _ => Err("actionAll accepts only normalized booleans".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|values| RuntimeValue::Bool(values.into_iter().all(|value| value))),
        ),
        ("actionAny", values) => Some(
            values
                .iter()
                .map(|value| match value {
                    RuntimeValue::Bool(value) => Ok(*value),
                    _ => Err("actionAny accepts only normalized booleans".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|values| RuntimeValue::Bool(values.into_iter().any(|value| value))),
        ),
        ("Present", [value]) => Some(Ok(RuntimeValue::Present(Box::new(value.clone())))),
        ("variant", [RuntimeValue::Text(tag), value]) => Some(Ok(RuntimeValue::Variant {
            tag: tag.clone(),
            value: Box::new(value.clone()),
        })),
        ("List", values) => Some(Ok(RuntimeValue::List(values.to_vec()))),
        ("Tup", values) => Some(Ok(RuntimeValue::Tuple(values.to_vec()))),
        ("Set", values) => Some(Ok(RuntimeValue::Set(values.iter().cloned().collect()))),
        ("Map", values) => Some(map_from_values(values)),
        ("Rec", values) => Some(record_from_values(values)),
        (
            "replicaPoolKey",
            [
                RuntimeValue::Text(replica_id),
                RuntimeValue::Record(pool_key),
            ],
        ) => Some(Ok(RuntimeValue::Record(BTreeMap::from([
            (
                "replica_id".to_owned(),
                RuntimeValue::Text(replica_id.clone()),
            ),
            (
                "pool_key".to_owned(),
                RuntimeValue::Record(pool_key.clone()),
            ),
        ])))),
        ("field", [RuntimeValue::Record(fields), RuntimeValue::Text(key)]) => Some(
            fields
                .get(key)
                .cloned()
                .ok_or_else(|| format!("runtime record has no field {key}")),
        ),
        ("get", [RuntimeValue::Record(fields), RuntimeValue::Text(key)]) => {
            Some(Ok(fields.get(key).cloned().unwrap_or(RuntimeValue::Absent)))
        }
        ("get", [RuntimeValue::Map(entries), key]) => Some(Ok(entries
            .get(key)
            .cloned()
            .ok_or_else(|| format!("map has no key {key:?}"))?)),
        ("contains", [RuntimeValue::Set(values), value]) => {
            Some(Ok(RuntimeValue::Bool(values.contains(value))))
        }
        ("length", [RuntimeValue::List(values)]) => {
            Some(Ok(RuntimeValue::Int(values.len() as i64)))
        }
        ("size", [RuntimeValue::List(values)]) => Some(Ok(RuntimeValue::Int(values.len() as i64))),
        ("size", [RuntimeValue::Tuple(values)]) => Some(Ok(RuntimeValue::Int(values.len() as i64))),
        ("size", [RuntimeValue::Set(values)]) => Some(Ok(RuntimeValue::Int(values.len() as i64))),
        ("size", [RuntimeValue::Map(values)]) => Some(Ok(RuntimeValue::Int(values.len() as i64))),
        ("size", [RuntimeValue::Record(values)]) => {
            Some(Ok(RuntimeValue::Int(values.len() as i64)))
        }
        ("and", values) => Some(
            values
                .iter()
                .map(|value| match value {
                    RuntimeValue::Bool(value) => Ok(*value),
                    _ => Err("and accepts only normalized booleans".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|values| RuntimeValue::Bool(values.into_iter().all(|value| value))),
        ),
        ("or", values) => Some(
            values
                .iter()
                .map(|value| match value {
                    RuntimeValue::Bool(value) => Ok(*value),
                    _ => Err("or accepts only normalized booleans".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|values| RuntimeValue::Bool(values.into_iter().any(|value| value))),
        ),
        ("with", [RuntimeValue::Record(fields), RuntimeValue::Text(key), value]) => {
            let mut updated = fields.clone();
            updated.insert(key.clone(), value.clone());
            Some(Ok(RuntimeValue::Record(updated)))
        }
        ("set", [RuntimeValue::Record(fields), RuntimeValue::Text(key), value]) => {
            let mut updated = fields.clone();
            updated.insert(key.clone(), value.clone());
            Some(Ok(RuntimeValue::Record(updated)))
        }
        ("set", [RuntimeValue::Map(entries), key, value]) => {
            if !entries.contains_key(key) {
                return Err(format!("set cannot add missing map key {key:?}"));
            }
            let mut updated = entries.clone();
            updated.insert(key.clone(), value.clone());
            Some(Ok(RuntimeValue::Map(updated)))
        }
        ("put", [RuntimeValue::Map(entries), key, value]) => {
            let mut updated = entries.clone();
            updated.insert(key.clone(), value.clone());
            Some(Ok(RuntimeValue::Map(updated)))
        }
        ("union", [RuntimeValue::Set(left), RuntimeValue::Set(right)]) => {
            Some(Ok(RuntimeValue::Set(left.union(right).cloned().collect())))
        }
        ("exclude", [RuntimeValue::Set(left), RuntimeValue::Set(right)]) => Some(Ok(
            RuntimeValue::Set(left.difference(right).cloned().collect()),
        )),
        ("ilt", [RuntimeValue::Int(left), RuntimeValue::Int(right)]) => {
            Some(Ok(RuntimeValue::Bool(left < right)))
        }
        ("igt", [RuntimeValue::Int(left), RuntimeValue::Int(right)]) => {
            Some(Ok(RuntimeValue::Bool(left > right)))
        }
        ("ilte", [RuntimeValue::Int(left), RuntimeValue::Int(right)]) => {
            Some(Ok(RuntimeValue::Bool(left <= right)))
        }
        ("igte", [RuntimeValue::Int(left), RuntimeValue::Int(right)]) => {
            Some(Ok(RuntimeValue::Bool(left >= right)))
        }
        ("iadd", [RuntimeValue::Int(left), RuntimeValue::Int(right)]) => {
            Some(Ok(RuntimeValue::Int(left + right)))
        }
        ("isub", [RuntimeValue::Int(left), RuntimeValue::Int(right)]) => {
            Some(Ok(RuntimeValue::Int(left - right)))
        }
        ("append", [RuntimeValue::List(values), value]) => {
            let mut appended = values.clone();
            appended.push(value.clone());
            Some(Ok(RuntimeValue::List(appended)))
        }
        ("concat", [RuntimeValue::List(left), RuntimeValue::List(right)]) => {
            let mut concatenated = left.clone();
            concatenated.extend(right.iter().cloned());
            Some(Ok(RuntimeValue::List(concatenated)))
        }
        ("indices", [RuntimeValue::List(values)]) => Some(
            values
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    i64::try_from(index)
                        .map(RuntimeValue::Int)
                        .map_err(|_| "list index exceeds normalized integer range".to_owned())
                })
                .collect::<Result<BTreeSet<_>, _>>()
                .map(RuntimeValue::Set),
        ),
        ("nth", [RuntimeValue::List(values), RuntimeValue::Int(index)]) => Some(
            usize::try_from(*index)
                .ok()
                .and_then(|index| values.get(index).cloned())
                .ok_or_else(|| format!("list index {index} is out of bounds")),
        ),
        ("keys", [RuntimeValue::Map(entries)]) => {
            Some(Ok(RuntimeValue::Set(entries.keys().cloned().collect())))
        }
        _ => None,
    };

    if let Some(result) = common.or_else(|| eval.current.resolve_call(operator, &values)) {
        return result;
    }
    if operator.chars().next().is_some_and(char::is_uppercase) {
        let [value] = values.as_slice() else {
            return Err(format!(
                "variant constructor {operator} requires one value, received {}",
                values.len()
            ));
        };
        return Ok(RuntimeValue::Variant {
            tag: operator.to_owned(),
            value: Box::new(value.clone()),
        });
    }
    Err(format!(
        "unsupported runtime operator {operator} for {values:?}"
    ))
}

fn structurally_equal(expected: &RuntimeValue, observed: &RuntimeValue) -> bool {
    structural_difference(expected, observed, "state").is_none()
}

fn structural_difference(
    expected: &RuntimeValue,
    observed: &RuntimeValue,
    path: &str,
) -> Option<String> {
    match (expected, observed) {
        (RuntimeValue::Record(expected_fields), RuntimeValue::Record(observed_fields)) => {
            if expected_fields.len() != observed_fields.len() {
                let missing = expected_fields
                    .keys()
                    .filter(|key| !observed_fields.contains_key(*key))
                    .cloned()
                    .collect::<Vec<_>>();
                let unexpected = observed_fields
                    .keys()
                    .filter(|key| !expected_fields.contains_key(*key))
                    .cloned()
                    .collect::<Vec<_>>();
                return Some(format!(
                    "{path} record fields differ; missing {missing:?}, unexpected {unexpected:?}"
                ));
            }
            for (key, expected_value) in expected_fields {
                let nested_path = format!("{path}.{key}");
                let Some(observed_value) = observed_fields.get(key) else {
                    return Some(format!("{nested_path} missing from observed state"));
                };
                if let Some(difference) =
                    structural_difference(expected_value, observed_value, &nested_path)
                {
                    return Some(difference);
                }
            }
            None
        }
        (RuntimeValue::Present(expected_value), RuntimeValue::Present(observed_value)) => {
            structural_difference(expected_value, observed_value, path)
        }
        (RuntimeValue::List(expected_values), RuntimeValue::List(observed_values)) => {
            if expected_values.len() != observed_values.len() {
                return Some(format!(
                    "{path} expected list length {}, observed {}",
                    expected_values.len(),
                    observed_values.len()
                ));
            }
            for (index, (expected_value, observed_value)) in
                expected_values.iter().zip(observed_values).enumerate()
            {
                if let Some(difference) = structural_difference(
                    expected_value,
                    observed_value,
                    &format!("{path}[{index}]"),
                ) {
                    return Some(difference);
                }
            }
            None
        }
        _ if expected == observed => None,
        _ => Some(format!(
            "{path} expected {expected:?}, observed {observed:?}"
        )),
    }
}

fn evaluate_ite<E: NormalizedRuntimeEvidence>(
    arguments: &[serde_json::Value],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let [condition, when_true, when_false] = arguments else {
        return Err("ite requires a condition and two branches".to_owned());
    };
    match evaluate_expression(condition, eval, environment)? {
        RuntimeValue::Bool(true) => evaluate_expression(when_true, eval, environment),
        RuntimeValue::Bool(false) => evaluate_expression(when_false, eval, environment),
        _ => Err("ite condition is not boolean".to_owned()),
    }
}

fn evaluate_quantifier<E: NormalizedRuntimeEvidence>(
    operator: &str,
    arguments: &[serde_json::Value],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let [values, lambda] = arguments else {
        return Err(format!("{operator} requires a collection and one lambda"));
    };
    let items = match evaluate_expression(values, eval, environment)? {
        RuntimeValue::Set(values) => values.into_iter().collect(),
        RuntimeValue::List(values) => values,
        RuntimeValue::Tuple(values) => values,
        RuntimeValue::Map(entries) => entries.into_values().collect(),
        RuntimeValue::Record(fields) => fields.into_values().collect(),
        _ => return Err(format!("{operator} input is not a collection")),
    };
    if lambda["kind"].as_str() != Some("lambda") {
        return Err(format!("{operator} predicate is not a lambda"));
    }
    let parameter = lambda["parameters"]
        .as_array()
        .and_then(|parameters| parameters.first())
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{operator} lambda has no parameter"))?;
    let body = &lambda["body"];
    let mut results = Vec::new();
    for value in items {
        let mut nested = environment.clone();
        nested.insert(parameter.to_owned(), value);
        match evaluate_expression(body, eval, &nested)? {
            RuntimeValue::Bool(value) => results.push(value),
            _ => return Err(format!("{operator} predicate did not evaluate to boolean")),
        }
    }
    Ok(RuntimeValue::Bool(if operator == "forall" {
        results.into_iter().all(|value| value)
    } else {
        results.into_iter().any(|value| value)
    }))
}

fn evaluate_filter<E: NormalizedRuntimeEvidence>(
    arguments: &[serde_json::Value],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let [values, lambda] = arguments else {
        return Err("filter requires a list and one lambda".to_owned());
    };
    let values = evaluate_expression(values, eval, environment)?;
    let (items, is_set) = match values {
        RuntimeValue::List(values) => (values, false),
        RuntimeValue::Set(values) => (values.into_iter().collect(), true),
        _ => return Err("filter input is not a list or set".to_owned()),
    };
    let mut filtered = Vec::new();
    for value in items {
        match evaluate_lambda(lambda, std::slice::from_ref(&value), eval, environment)? {
            RuntimeValue::Bool(true) => filtered.push(value),
            RuntimeValue::Bool(false) => {}
            _ => return Err("filter predicate did not evaluate to boolean".to_owned()),
        }
    }
    if is_set {
        Ok(RuntimeValue::Set(filtered.into_iter().collect()))
    } else {
        Ok(RuntimeValue::List(filtered))
    }
}

fn evaluate_map<E: NormalizedRuntimeEvidence>(
    operator: &str,
    arguments: &[serde_json::Value],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let [values, lambda] = arguments else {
        return Err(format!("{operator} requires a set and one lambda"));
    };
    let RuntimeValue::Set(values) = evaluate_expression(values, eval, environment)? else {
        return Err(format!("{operator} input is not a set"));
    };
    if operator == "map" {
        return values
            .into_iter()
            .map(|value| evaluate_lambda(lambda, &[value], eval, environment))
            .collect::<Result<BTreeSet<_>, _>>()
            .map(RuntimeValue::Set);
    }
    values
        .into_iter()
        .map(|key| {
            let value = evaluate_lambda(lambda, std::slice::from_ref(&key), eval, environment)?;
            Ok((key, value))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map(RuntimeValue::Map)
}

fn evaluate_fold<E: NormalizedRuntimeEvidence>(
    arguments: &[serde_json::Value],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let [values, initial, lambda] = arguments else {
        return Err("fold requires a set, initial value, and lambda".to_owned());
    };
    let RuntimeValue::Set(values) = evaluate_expression(values, eval, environment)? else {
        return Err("fold input is not a set".to_owned());
    };
    let mut accumulator = evaluate_expression(initial, eval, environment)?;
    for value in values {
        accumulator = evaluate_lambda(lambda, &[accumulator, value], eval, environment)?;
    }
    Ok(accumulator)
}

fn evaluate_lambda<E: NormalizedRuntimeEvidence>(
    lambda: &serde_json::Value,
    arguments: &[RuntimeValue],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    if lambda["kind"].as_str() != Some("lambda") {
        return Err("expected a normalized lambda".to_owned());
    }
    let parameters = lambda["parameters"]
        .as_array()
        .ok_or_else(|| "normalized lambda has no parameters".to_owned())?;
    if parameters.len() != arguments.len() {
        return Err(format!(
            "lambda expects {} arguments, received {}",
            parameters.len(),
            arguments.len()
        ));
    }
    let mut nested = environment.clone();
    for (parameter, value) in parameters.iter().zip(arguments) {
        let name = parameter
            .as_str()
            .ok_or_else(|| "normalized lambda parameter is not a name".to_owned())?;
        nested.insert(name.to_owned(), value.clone());
    }
    evaluate_expression(&lambda["body"], eval, &nested)
}

fn evaluate_match_variant<E: NormalizedRuntimeEvidence>(
    arguments: &[serde_json::Value],
    eval: &Eval<'_, E>,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let variant = evaluate_expression(
        arguments
            .first()
            .ok_or_else(|| "matchVariant has no value".to_owned())?,
        eval,
        environment,
    )?;
    let (tag, value) = match variant {
        RuntimeValue::Absent => ("Absent".to_owned(), None),
        RuntimeValue::Present(value) => ("Present".to_owned(), Some(*value)),
        RuntimeValue::Variant { tag, value } => (tag, Some(*value)),
        RuntimeValue::Text(tag) => (tag, Some(RuntimeValue::Tuple(Vec::new()))),
        _ => return Err("matchVariant value is not a normalized variant".to_owned()),
    };
    for branch in arguments[1..].chunks_exact(2) {
        let RuntimeValue::Text(branch_tag) = evaluate_expression(&branch[0], eval, environment)?
        else {
            return Err("matchVariant tag is not text".to_owned());
        };
        if branch_tag != tag {
            continue;
        }
        let lambda = &branch[1];
        if lambda["kind"].as_str() != Some("lambda") {
            return Err("matchVariant branch is not a lambda".to_owned());
        }
        let parameter = lambda["parameters"]
            .as_array()
            .and_then(|parameters| parameters.first())
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "matchVariant lambda has no parameter".to_owned())?;
        let mut branch_environment = environment.clone();
        if let Some(value) = value {
            branch_environment.insert(parameter.to_owned(), value);
        }
        return evaluate_expression(&lambda["body"], eval, &branch_environment);
    }
    Err("matchVariant has no matching branch".to_owned())
}

fn record_from_values(values: &[RuntimeValue]) -> Result<RuntimeValue, String> {
    if values.len() % 2 != 0 {
        return Err("Rec requires key and value pairs".to_owned());
    }
    let mut fields = BTreeMap::new();
    for pair in values.chunks_exact(2) {
        let RuntimeValue::Text(key) = &pair[0] else {
            return Err("Rec key is not text".to_owned());
        };
        fields.insert(key.clone(), pair[1].clone());
    }
    Ok(RuntimeValue::Record(fields))
}

fn map_from_values(values: &[RuntimeValue]) -> Result<RuntimeValue, String> {
    let mut entries = BTreeMap::new();
    for value in values {
        let RuntimeValue::Tuple(pair) = value else {
            return Err("Map accepts only key/value tuples".to_owned());
        };
        let [key, value] = pair.as_slice() else {
            return Err("Map entries must contain exactly two values".to_owned());
        };
        entries.insert(key.clone(), value.clone());
    }
    Ok(RuntimeValue::Map(entries))
}
