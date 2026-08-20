use crate::artifact::ArtifactScenario;
use crate::evaluate::{NormalizedRuntimeEvidence, evaluate_every_action_step};
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
/// once, and evaluate guards/next on the resulting tape.
pub fn refine_scenario<D: PrimitiveDriver>(
    scenario: &ArtifactScenario,
    init: D::Evidence,
    ownership: &[OwnershipDescriptor],
    retrieve: &[&str],
    driver: &mut D,
) -> Result<usize, String> {
    let snapshots =
        collect_owned_action_snapshots(scenario, init, ownership, |primitive, owned_actions| {
            driver.run_primitive(primitive, owned_actions)
        })?;
    evaluate_every_action_step(scenario, &snapshots, retrieve)
}
