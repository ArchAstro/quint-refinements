use std::future::Future;

use crate::artifact::ArtifactScenario;
use crate::evaluate::{NormalizedRuntimeEvidence, evaluate_all_action_steps};
use crate::fixtures::{BoundEvidence, FixtureTable};
use crate::ownership::OwnershipDescriptor;
use crate::schedule::{
    collect_owned_action_snapshots, extend_validated_tape, scenario_action_names,
    schedule_primitive_runs,
};

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

/// Async domain plug-in for real process, actor, socket, or database commands.
///
/// Like [`PrimitiveDriver`], one implementation command returns one snapshot
/// per ordered Quint action it refines. The returned future is `Send` so a
/// generic refinement can run under a multi-threaded executor without boxing.
pub trait AsyncPrimitiveDriver {
    type Evidence: NormalizedRuntimeEvidence;

    fn run_primitive(
        &mut self,
        primitive: &str,
        owned_actions: &[String],
    ) -> impl Future<Output = Result<Vec<Self::Evidence>, String>> + Send;
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

/// Async form of [`refine_scenario`] for production boundaries.
///
/// Scheduling and tape cardinality use the same checks as the synchronous
/// loop. Primitives run sequentially because each retrieve-before snapshot is
/// the preceding action's retrieve-after snapshot.
pub async fn refine_scenario_async<D: AsyncPrimitiveDriver>(
    scenario: &ArtifactScenario,
    init: D::Evidence,
    ownership: &[OwnershipDescriptor],
    retrieve: &[&str],
    fixtures: &FixtureTable,
    driver: &mut D,
) -> Result<usize, String> {
    let actions = scenario_action_names(scenario);
    let runs = schedule_primitive_runs(&actions, ownership)?;
    let mut snapshots = vec![init];
    for run in runs {
        let tape = driver
            .run_primitive(&run.primitive, &run.owned_actions)
            .await?;
        extend_validated_tape(&mut snapshots, &run, tape)?;
    }
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
