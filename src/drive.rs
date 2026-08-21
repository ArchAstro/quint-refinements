use crate::artifact::ArtifactScenario;
use crate::evaluate::{NormalizedRuntimeEvidence, evaluate_all_action_steps};
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
    evaluate_refined_tape(scenario, &snapshots, retrieve, fixtures)
}

/// Bind fixtures in front of an already-collected snapshot tape and evaluate
/// every guard and next conjunct.
pub fn evaluate_refined_tape<E: NormalizedRuntimeEvidence>(
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
    evaluate_all_action_steps(scenario, &bound, &bound_retrieve)
}
