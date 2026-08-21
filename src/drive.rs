use crate::artifact::ArtifactScenario;
use crate::evaluate::{
    NormalizedRuntimeEvidence, evaluate_all_action_steps, evaluate_all_step_obligations,
    operators_are_supported,
};
use crate::fixtures::expression_names;
use crate::fixtures::{BoundEvidence, FixtureTable};
use crate::ownership::OwnershipDescriptor;
use crate::schedule::collect_owned_action_snapshots;

/// Domain plug-in: run one implementation primitive and return one snapshot
/// per `refines` step, in that order.
///
/// Declare 1-to-N with `refines: [a, b, c]` on the ownership record. The driver
/// runs the impl command once and returns three evidences. Aliases are not a
/// sequence.
pub trait PrimitiveDriver {
    type Evidence: NormalizedRuntimeEvidence;

    fn run_primitive(
        &mut self,
        primitive: &str,
        owned_actions: &[String],
    ) -> Result<Vec<Self::Evidence>, String>;
}

/// Walk the generated JSON through ownership records, run each primitive
/// once, and evaluate **every** guard/next conjunct on the resulting tape.
///
/// `fixtures` owns Quint names (`Idle`, `attemptA`, universe sets). Snapshots
/// own live `state`. Model-scope conjuncts are not skipped.
pub fn refine_scenario<D: PrimitiveDriver>(
    scenario: &ArtifactScenario,
    init: D::Evidence,
    ownership: &[OwnershipDescriptor],
    retrieve: &[&str],
    fixtures: &FixtureTable,
    driver: &mut D,
) -> Result<usize, String> {
    let snapshots =
        collect_owned_action_snapshots(scenario, init, ownership, |primitive, owned_actions| {
            driver.run_primitive(primitive, owned_actions)
        })?;
    let bound = snapshots
        .iter()
        .map(|snapshot| BoundEvidence { fixtures, snapshot })
        .collect::<Vec<_>>();
    let extra = fixtures.retrieve_names();
    let mut bound_retrieve = retrieve.to_vec();
    bound_retrieve.extend(extra.iter().map(String::as_str));
    evaluate_all_action_steps(scenario, &bound, &bound_retrieve)
}

/// Evaluate conjuncts whose operators the crate implements. Fixture-only
/// conjuncts (no `state`) must be supported or this fails closed. Nested Quint
/// helpers (`retryOpen`, `with`, …) are left for inlining.
pub fn evaluate_owned_conjuncts<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    fixtures: &FixtureTable,
) -> Result<usize, String> {
    let bound = snapshots
        .iter()
        .map(|snapshot| BoundEvidence { fixtures, snapshot })
        .collect::<Vec<_>>();
    let extra = fixtures.retrieve_names();
    let mut bound_retrieve = retrieve.to_vec();
    bound_retrieve.extend(extra.iter().map(String::as_str));
    let actions = scenario
        .steps
        .iter()
        .filter_map(|step| match step {
            crate::artifact::ArtifactStep::Action {
                action,
                guards,
                next,
                ..
            } => Some((action.as_str(), guards.as_slice(), next.as_slice())),
            _ => None,
        })
        .collect::<Vec<_>>();
    if bound.len() != actions.len() + 1 {
        return Err(format!(
            "{} has {} actions but {} snapshots (want init plus one after each action)",
            scenario.id(),
            actions.len(),
            bound.len()
        ));
    }
    let mut evaluated = 0;
    for (index, (action, guards, next)) in actions.iter().enumerate() {
        let owned_guards = owned_assertions(guards, fixtures);
        let owned_next = owned_assertions(next, fixtures);
        if owned_guards.is_empty() && owned_next.is_empty() {
            continue;
        }
        evaluated += evaluate_all_step_obligations(
            &scenario.id(),
            action,
            &owned_guards,
            &owned_next,
            &bound[index],
            &bound[index + 1],
            &bound_retrieve,
        )?;
    }
    Ok(evaluated)
}

fn owned_assertions(
    assertions: &[crate::artifact::ArtifactAssertion],
    fixtures: &FixtureTable,
) -> Vec<crate::artifact::ArtifactAssertion> {
    assertions
        .iter()
        .filter(|assertion| {
            let names = expression_names(&assertion.expression);
            names.iter().any(|name| fixtures.contains_name(name))
                && names.iter().all(|name| name != "state")
                && operators_are_supported(&assertion.expression)
        })
        .cloned()
        .collect()
}
