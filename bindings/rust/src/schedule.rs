use crate::artifact::{ArtifactScenario, ArtifactStep};
use crate::ownership::OwnershipDescriptor;

/// One impl command the JSON driver must run, and the Quint actions it fills.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledPrimitiveRun {
    /// Stable identifier of the implementation command to execute.
    pub primitive: String,
    /// Ordered model actions covered by this single execution.
    pub owned_actions: Vec<String>,
}

/// Action names from the generated scenario, in JSON order.
#[must_use]
pub fn scenario_action_names(scenario: &ArtifactScenario) -> Vec<&str> {
    scenario
        .steps
        .iter()
        .filter_map(|step| match step {
            ArtifactStep::Action { action, .. } => Some(action.as_str()),
            ArtifactStep::Init { .. } | ArtifactStep::Observe { .. } => None,
        })
        .collect()
}

enum OwnershipFit<'a> {
    Compound(&'a OwnershipDescriptor),
    PartialCompound(&'a OwnershipDescriptor),
    Singleton(&'a OwnershipDescriptor),
}

fn fit_record<'a>(record: &'a OwnershipDescriptor, remaining: &[&str]) -> Option<OwnershipFit<'a>> {
    if remaining.is_empty() {
        return None;
    }
    if !record.refines.is_empty() {
        let refines = record
            .refines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        if remaining.starts_with(&refines) {
            return Some(if refines.len() > 1 {
                OwnershipFit::Compound(record)
            } else {
                OwnershipFit::Singleton(record)
            });
        }
        if refines.len() > 1 && remaining[0] == refines[0] && remaining.get(1) == refines.get(1) {
            return Some(OwnershipFit::PartialCompound(record));
        }
        if record.aliases.iter().any(|alias| alias == remaining[0]) {
            return Some(OwnershipFit::Singleton(record));
        }
        return None;
    }
    if record.actions.iter().any(|action| action == remaining[0]) {
        return Some(OwnershipFit::Singleton(record));
    }
    None
}

/// Walks generated actions against ownership records.
///
/// `refines` is the ordered spec tape of one impl command. JSON must present
/// that sequence intact. `aliases` are extra names for a 1-step refine.
/// Legacy `actions` lists (no `refines`) stay independent 1-step runs.
pub fn schedule_primitive_runs(
    json_actions: &[&str],
    ownership: &[OwnershipDescriptor],
) -> Result<Vec<ScheduledPrimitiveRun>, String> {
    let mut index = 0;
    let mut runs = Vec::new();
    while index < json_actions.len() {
        let remaining = &json_actions[index..];
        let mut compounds = Vec::new();
        let mut partials = Vec::new();
        let mut singletons = Vec::new();
        for record in ownership {
            match fit_record(record, remaining) {
                Some(OwnershipFit::Compound(record)) => compounds.push(record),
                Some(OwnershipFit::PartialCompound(record)) => partials.push(record),
                Some(OwnershipFit::Singleton(record)) => singletons.push(record),
                None => {}
            }
        }
        if let Some(record) = unique_record(&compounds, remaining[0])? {
            let consumed = record.refines.len();
            runs.push(ScheduledPrimitiveRun {
                primitive: record.primitive.clone(),
                owned_actions: record.refines.clone(),
            });
            index += consumed;
            continue;
        }
        if !partials.is_empty() {
            return Err(format!(
                "primitive {} JSON actions [{}] are not the owned sequence [{}]",
                partials[0].primitive,
                remaining
                    .iter()
                    .take(partials[0].refines.len())
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", "),
                partials[0].refines.join(", ")
            ));
        }
        let record = unique_record(&singletons, remaining[0])?
            .ok_or_else(|| format!("JSON action {} has no ownership record", remaining[0]))?;
        runs.push(ScheduledPrimitiveRun {
            primitive: record.primitive.clone(),
            owned_actions: vec![remaining[0].to_owned()],
        });
        index += 1;
    }
    Ok(runs)
}

fn unique_record<'a>(
    records: &[&'a OwnershipDescriptor],
    action: &str,
) -> Result<Option<&'a OwnershipDescriptor>, String> {
    match records {
        [] => Ok(None),
        [record] => Ok(Some(record)),
        _ => {
            let primitives = records
                .iter()
                .map(|record| record.primitive.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!(
                "JSON action {action} is owned by multiple primitives ({primitives})"
            ))
        }
    }
}

/// Builds init plus one retrieve-after snapshot per JSON action.
///
/// `run_primitive` runs the impl command for one scheduled tape and must
/// return exactly `owned_actions.len()` evidences in that order.
pub fn collect_owned_action_snapshots<E, F>(
    scenario: &ArtifactScenario,
    init: E,
    ownership: &[OwnershipDescriptor],
    mut run_primitive: F,
) -> Result<Vec<E>, String>
where
    F: FnMut(&str, &[String]) -> Result<Vec<E>, String>,
{
    let actions = scenario_action_names(scenario);
    let runs = schedule_primitive_runs(&actions, ownership)?;
    let mut snapshots = vec![init];
    for run in runs {
        let tape = run_primitive(&run.primitive, &run.owned_actions)?;
        extend_validated_tape(&mut snapshots, &run, tape)?;
    }
    Ok(snapshots)
}

pub(crate) fn extend_validated_tape<E>(
    snapshots: &mut Vec<E>,
    run: &ScheduledPrimitiveRun,
    tape: Vec<E>,
) -> Result<(), String> {
    if tape.len() != run.owned_actions.len() {
        return Err(format!(
            "primitive {} owns {} actions but returned {} evidence snapshots",
            run.primitive,
            run.owned_actions.len(),
            tape.len()
        ));
    }
    snapshots.extend(tape);
    Ok(())
}
