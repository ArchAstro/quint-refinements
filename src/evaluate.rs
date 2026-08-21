use std::collections::{BTreeMap, BTreeSet};

use crate::artifact::{ArtifactAssertion, ArtifactScenario, ArtifactStep, AssertionScope};

/// A normalized Q12 value reconstructed from runtime-owned evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeValue {
    Bool(bool),
    Int(i64),
    Text(String),
    Set(BTreeSet<String>),
    List(Vec<Self>),
    Record(BTreeMap<String, Self>),
    Absent,
    Present(Box<Self>),
}

/// Resolves the domain-specific names and calls used by a Q12 runtime adapter.
///
/// The shared evaluator owns the normalized expression grammar. Implementors
/// expose only evidence that is specific to one runtime scenario family.
pub trait NormalizedRuntimeEvidence {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String>;

    fn resolve_call(
        &self,
        operator: &str,
        arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>>;
}

/// Evaluates every non-model assertion in a checked Q12 scenario.
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
        evaluated += evaluate_assertions(
            &scenario.id(),
            "observe",
            assertions,
            evidence,
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
pub fn evaluate_step_obligations(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    before: &impl NormalizedRuntimeEvidence,
    after: &impl NormalizedRuntimeEvidence,
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

/// Evaluates every guard and next conjunct, including model-scope.
pub fn evaluate_all_step_obligations(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    before: &impl NormalizedRuntimeEvidence,
    after: &impl NormalizedRuntimeEvidence,
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
fn evaluate_step_obligations_inner(
    scenario_id: &str,
    action: &str,
    guards: &[ArtifactAssertion],
    next: &[ArtifactAssertion],
    before: &impl NormalizedRuntimeEvidence,
    after: &impl NormalizedRuntimeEvidence,
    retrieve: &[&str],
    skip_model: bool,
) -> Result<usize, String> {
    if guards.is_empty() && next.is_empty() {
        return Ok(0);
    }
    let context = format!("{scenario_id}:{action}");
    let mut evaluated = 0;
    evaluated += evaluate_assertions(&context, "guard", guards, before, retrieve, skip_model)?;
    let (assigns, other_next): (Vec<_>, Vec<_>) = next
        .iter()
        .cloned()
        .partition(|assertion| is_assign(&assertion.expression));
    evaluated += evaluate_assertions(&context, "next", &other_next, after, retrieve, skip_model)?;
    evaluated += evaluate_assigns(&context, &assigns, before, after, retrieve, skip_model)?;
    if evaluated == 0 {
        return Err(format!(
            "{context} declared step obligations but evaluated none"
        ));
    }
    Ok(evaluated)
}

fn is_assign(expression: &serde_json::Value) -> bool {
    expression["kind"].as_str() == Some("call") && expression["operator"].as_str() == Some("assign")
}

fn evaluate_assigns(
    context: &str,
    assertions: &[ArtifactAssertion],
    before: &impl NormalizedRuntimeEvidence,
    after: &impl NormalizedRuntimeEvidence,
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
                "{context} next uses unsupported runtime dependency {dependency}"
            ));
        }
        let arguments = assertion.expression["arguments"]
            .as_array()
            .ok_or_else(|| format!("{context} assign has no arguments"))?;
        let [left, right] = arguments.as_slice() else {
            return Err(format!("{context} assign requires a variable and an expression"));
        };
        // Quint: RHS of x' = e is evaluated in the current state; LHS is the next state.
        let expected = evaluate_expression(right, before, &BTreeMap::new())?;
        let observed = evaluate_expression(left, after, &BTreeMap::new())?;
        if expected == observed {
            evaluated += 1;
        } else {
            return Err(format!(
                "next assignment evaluated false in {context}: {}",
                assertion.expression
            ));
        }
    }
    Ok(evaluated)
}

fn evaluate_assertions(
    context: &str,
    kind: &str,
    assertions: &[ArtifactAssertion],
    evidence: &impl NormalizedRuntimeEvidence,
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
        match evaluate_expression(&assertion.expression, evidence, &BTreeMap::new())? {
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
            | "operator:assign"
    ) || supported.contains(dependency)
}

fn evaluate_expression(
    expression: &serde_json::Value,
    evidence: &impl NormalizedRuntimeEvidence,
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
            environment
                .get(name)
                .cloned()
                .map_or_else(|| evidence.resolve_name(name), Ok)
        }
        Some("call") => evaluate_call(expression, evidence, environment),
        Some("let") => evaluate_let(expression, evidence, environment),
        _ => Err("unsupported normalized expression kind".to_owned()),
    }
}

fn evaluate_let(
    expression: &serde_json::Value,
    evidence: &impl NormalizedRuntimeEvidence,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let name = expression["name"]
        .as_str()
        .ok_or_else(|| "normalized let has no name".to_owned())?;
    let value = evaluate_expression(&expression["value"], evidence, environment)?;
    let mut nested = environment.clone();
    nested.insert(name.to_owned(), value);
    evaluate_expression(&expression["body"], evidence, &nested)
}

fn evaluate_call(
    expression: &serde_json::Value,
    evidence: &impl NormalizedRuntimeEvidence,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let operator = expression["operator"]
        .as_str()
        .ok_or_else(|| "normalized call has no operator".to_owned())?;
    let arguments = expression["arguments"]
        .as_array()
        .ok_or_else(|| "normalized call has no arguments".to_owned())?;
    if operator == "matchVariant" {
        return evaluate_match_variant(arguments, evidence, environment);
    }
    if operator == "filter" {
        return evaluate_filter(arguments, evidence, environment);
    }
    let values = arguments
        .iter()
        .map(|argument| evaluate_expression(argument, evidence, environment))
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
        ("Present", [value]) => Some(Ok(RuntimeValue::Present(Box::new(value.clone())))),
        ("Set", values) => Some(
            values
                .iter()
                .map(|value| match value {
                    RuntimeValue::Text(value) => Ok(value.clone()),
                    _ => Err("Set accepts only normalized text".to_owned()),
                })
                .collect::<Result<BTreeSet<_>, _>>()
                .map(RuntimeValue::Set),
        ),
        ("Rec", values) => Some(record_from_values(values)),
        ("field", [RuntimeValue::Record(fields), RuntimeValue::Text(key)]) => Some(
            fields
                .get(key)
                .cloned()
                .ok_or_else(|| format!("runtime record has no field {key}")),
        ),
        ("get", [RuntimeValue::Record(fields), RuntimeValue::Text(key)]) => {
            Some(Ok(fields.get(key).cloned().unwrap_or(RuntimeValue::Absent)))
        }
        ("contains", [RuntimeValue::Set(values), RuntimeValue::Text(value)]) => {
            Some(Ok(RuntimeValue::Bool(values.contains(value))))
        }
        ("length", [RuntimeValue::List(values)]) => {
            Some(Ok(RuntimeValue::Int(values.len() as i64)))
        }
        ("size", [RuntimeValue::List(values)]) => Some(Ok(RuntimeValue::Int(values.len() as i64))),
        ("size", [RuntimeValue::Set(values)]) => Some(Ok(RuntimeValue::Int(values.len() as i64))),
        ("size", [RuntimeValue::Record(values)]) => {
            Some(Ok(RuntimeValue::Int(values.len() as i64)))
        }
        _ => None,
    };

    common
        .or_else(|| evidence.resolve_call(operator, &values))
        .unwrap_or_else(|| Err(format!("unsupported runtime operator {operator}")))
}

fn evaluate_filter(
    arguments: &[serde_json::Value],
    evidence: &impl NormalizedRuntimeEvidence,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let [values, lambda] = arguments else {
        return Err("filter requires a list and one lambda".to_owned());
    };
    let RuntimeValue::List(values) = evaluate_expression(values, evidence, environment)? else {
        return Err("filter input is not a list".to_owned());
    };
    if lambda["kind"].as_str() != Some("lambda") {
        return Err("filter predicate is not a lambda".to_owned());
    }
    let parameter = lambda["parameters"]
        .as_array()
        .and_then(|parameters| parameters.first())
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "filter lambda has no parameter".to_owned())?;
    let body = &lambda["body"];
    let mut filtered = Vec::new();
    for value in values {
        let mut nested = environment.clone();
        nested.insert(parameter.to_owned(), value.clone());
        match evaluate_expression(body, evidence, &nested)? {
            RuntimeValue::Bool(true) => filtered.push(value),
            RuntimeValue::Bool(false) => {}
            _ => return Err("filter predicate did not evaluate to boolean".to_owned()),
        }
    }
    Ok(RuntimeValue::List(filtered))
}

fn evaluate_match_variant(
    arguments: &[serde_json::Value],
    evidence: &impl NormalizedRuntimeEvidence,
    environment: &BTreeMap<String, RuntimeValue>,
) -> Result<RuntimeValue, String> {
    let variant = evaluate_expression(
        arguments
            .first()
            .ok_or_else(|| "matchVariant has no value".to_owned())?,
        evidence,
        environment,
    )?;
    let (tag, value) = match variant {
        RuntimeValue::Absent => ("Absent", None),
        RuntimeValue::Present(value) => ("Present", Some(*value)),
        _ => return Err("matchVariant value is not optional".to_owned()),
    };
    for branch in arguments[1..].chunks_exact(2) {
        let RuntimeValue::Text(branch_tag) =
            evaluate_expression(&branch[0], evidence, environment)?
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
        return evaluate_expression(&lambda["body"], evidence, &branch_environment);
    }
    Err("matchVariant has no matching branch".to_owned())
}

fn record_from_values(values: &[RuntimeValue]) -> Result<RuntimeValue, String> {
    if !values.len().is_multiple_of(2) {
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
