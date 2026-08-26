use std::future::Future;

use crate::artifact::{ArtifactScenario, ArtifactStep};
use crate::evaluate::{
    NormalizedRuntimeEvidence, RuntimeValue, evaluate_action_arguments, evaluate_all_action_steps,
    evaluate_projected_action_step, evaluate_projected_action_steps, evaluate_projected_pre_guards,
    evaluate_projected_prefix_state,
};
use crate::fixtures::{BoundEvidence, FixtureTable};
use crate::ownership::OwnershipDescriptor;
use crate::schedule::{extend_validated_tape, scenario_action_names, schedule_primitive_runs};

/// One generated Quint action with arguments normalized through Rust fixtures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedAction {
    /// Generated Quint action name.
    pub name: String,
    /// Action arguments evaluated against the current reduced state and fixtures.
    pub arguments: Vec<RuntimeValue>,
}

/// Resolve the generated action stream against the hydrated initial fixture.
///
/// Drivers use this when a real boundary needs deterministic configuration
/// from the scenario (for example, connection IDs) before dispatch begins.
pub fn resolve_action_plan<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    init: &E,
    fixtures: &FixtureTable,
) -> Result<Vec<ResolvedAction>, String> {
    let bound = BoundEvidence {
        fixtures,
        snapshot: init,
    };
    scenario
        .steps
        .iter()
        .filter(|step| matches!(step, ArtifactStep::Action { .. }))
        .map(|step| {
            let ArtifactStep::Action { action, .. } = step else {
                unreachable!("action iterator returns only action steps")
            };
            Ok(ResolvedAction {
                name: action.clone(),
                arguments: evaluate_action_arguments(step, &bound)?,
            })
        })
        .collect()
}

/// Domain plug-in: run one implementation primitive and return one snapshot
/// per `refines` step, in that order.
///
/// Declare 1-to-N with `refines: [a, b, c]` on the ownership record. The driver
/// runs the impl command once and returns three evidences. Aliases are not a
/// sequence.
pub trait PrimitiveDriver {
    /// Snapshot type returned by the implementation adapter.
    type Evidence: NormalizedRuntimeEvidence;

    /// Executes `primitive` once and returns one snapshot per resolved action.
    fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String>;
}

/// Async domain plug-in for real process, actor, socket, or database commands.
///
/// Like [`PrimitiveDriver`], one implementation command returns one snapshot
/// per ordered Quint action it refines. The returned future is `Send` so a
/// generic refinement can run under a multi-threaded executor without boxing.
pub trait AsyncPrimitiveDriver {
    /// Snapshot type returned by the implementation adapter.
    type Evidence: NormalizedRuntimeEvidence;

    /// Asynchronously executes `primitive` once and returns its ordered snapshots.
    fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> impl Future<Output = Result<Vec<Self::Evidence>, String>> + Send;
}

/// Domain plug-in for a generated scenario whose Rust boundary is dispatched
/// one Quint action at a time.
///
/// The returned evidence is a sparse observation of fields owned by that
/// action. The runner merges it into Quint's assigned state before resolving
/// or dispatching the next action.
pub trait AsyncActionDriver {
    /// Sparse observation returned after one action crosses the implementation boundary.
    type Evidence: NormalizedRuntimeEvidence;

    /// Executes one resolved action and returns its observed implementation state.
    fn run_action(
        &mut self,
        action: &ResolvedAction,
    ) -> impl Future<Output = Result<Self::Evidence, String>> + Send;
}

/// The evidence tape and obligation count produced by a stepwise run.
pub struct RefinementRun<E> {
    /// Initial evidence followed by one recorded snapshot per action.
    pub snapshots: Vec<E>,
    /// Number of generated obligations evaluated during the run.
    pub evaluated: usize,
}

/// Stateful reducer for runners whose live resources stay in a local harness.
///
/// `next_action` validates pre-guards and resolves arguments. `record` merges
/// the sparse Rust observation and validates the post-state before another
/// generated action can be requested.
pub struct RefinementSession<'a, E> {
    scenario: &'a ArtifactScenario,
    retrieve: &'a [&'a str],
    fixtures: &'a FixtureTable,
    steps: Vec<&'a ArtifactStep>,
    snapshots: Vec<E>,
    state: RuntimeValue,
    next_index: usize,
    evaluated: usize,
    awaiting_observation: bool,
}

impl<'a, E: NormalizedRuntimeEvidence> RefinementSession<'a, E> {
    /// Starts a stateful refinement session from generated initial state and runtime evidence.
    pub fn new(
        scenario: &'a ArtifactScenario,
        init: E,
        retrieve: &'a [&'a str],
        fixtures: &'a FixtureTable,
    ) -> Result<Self, String> {
        let snapshots = vec![init];
        let state = initial_projected_state(scenario, &snapshots, retrieve, fixtures)?;
        Ok(Self {
            scenario,
            retrieve,
            fixtures,
            steps: action_steps(scenario),
            snapshots,
            state,
            next_index: 0,
            evaluated: 0,
            awaiting_observation: false,
        })
    }

    /// Validates the current prefix and resolves the next action for dispatch.
    pub fn next_action(&mut self) -> Result<Option<ResolvedAction>, String> {
        if self.awaiting_observation {
            return Err(
                "record the preceding Rust action observation before requesting another action"
                    .to_owned(),
            );
        }
        let Some(step) = self.steps.get(self.next_index) else {
            return Ok(None);
        };
        let snapshot = latest_snapshot(&self.snapshots)?;
        evaluate_run_pre_guards(
            self.scenario,
            self.next_index,
            &self.state,
            snapshot,
            self.retrieve,
            self.fixtures,
        )?;
        let action = resolve_action(step, &self.state, snapshot, self.fixtures)?;
        self.awaiting_observation = true;
        Ok(Some(action))
    }

    /// Records sparse implementation evidence and reduces the generated next state.
    pub fn record(&mut self, evidence: E) -> Result<(), String> {
        if !self.awaiting_observation {
            return Err(
                "cannot record Rust evidence without a dispatched generated action".to_owned(),
            );
        }
        self.snapshots.push(evidence);
        let ArtifactStep::Action {
            action,
            guards,
            next,
            ..
        } = self.steps[self.next_index]
        else {
            unreachable!("refinement session stores only action steps")
        };
        let before = BoundEvidence {
            fixtures: self.fixtures,
            snapshot: &self.snapshots[self.next_index],
        };
        let after = BoundEvidence {
            fixtures: self.fixtures,
            snapshot: &self.snapshots[self.next_index + 1],
        };
        let extra = self.fixtures.retrieve_names();
        let mut retrieve = self.retrieve.to_vec();
        retrieve.extend(extra.iter().map(String::as_str));
        let (evaluated, state) = evaluate_projected_action_step(
            &self.scenario.id(),
            action,
            guards,
            next,
            &self.state,
            &before,
            &after,
            &retrieve,
        )?;
        self.evaluated += evaluated;
        self.state = state;
        self.next_index += 1;
        self.awaiting_observation = false;
        Ok(())
    }

    /// Completes the session after every generated action has been recorded.
    pub fn finish(self) -> Result<RefinementRun<E>, String> {
        if self.awaiting_observation {
            return Err("generated action was dispatched without a Rust observation".to_owned());
        }
        if self.next_index != self.steps.len() {
            return Err(format!(
                "{} stopped after {} of {} generated actions",
                self.scenario.id(),
                self.next_index,
                self.steps.len()
            ));
        }
        Ok(RefinementRun {
            snapshots: self.snapshots,
            evaluated: self.evaluated,
        })
    }
}

/// Hydrate a fixture from Quint and dispatch the generated scenario one action
/// at a time.
///
/// Each action's pre-guards and arguments use the accumulated state from the
/// preceding prefix. The Rust action returns only its observed subset; Quint's
/// assignment supplies the rest of the next state. Post-guards and `next` are
/// evaluated before the following action is allowed to run.
pub async fn run_refined_actions_async<D: AsyncActionDriver>(
    scenario: &ArtifactScenario,
    init: D::Evidence,
    retrieve: &[&str],
    fixtures: &FixtureTable,
    driver: &mut D,
) -> Result<RefinementRun<D::Evidence>, String> {
    let mut session = RefinementSession::new(scenario, init, retrieve, fixtures)?;
    while let Some(action) = session.next_action()? {
        session.record(driver.run_action(&action).await?)?;
    }
    session.finish()
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
    let action_names = scenario_action_names(scenario);
    let runs = schedule_primitive_runs(&action_names, ownership)?;
    let action_steps = action_steps(scenario);
    let mut snapshots = vec![init];
    let mut action_offset = 0;
    let mut state = initial_projected_state(scenario, &snapshots, retrieve, fixtures)?;
    for run in runs {
        let snapshot = latest_snapshot(&snapshots)?;
        evaluate_run_pre_guards(
            scenario,
            action_offset,
            &state,
            snapshot,
            retrieve,
            fixtures,
        )?;
        let actions = resolve_run_actions(
            &run,
            &action_steps,
            action_offset,
            &state,
            snapshot,
            fixtures,
        )?;
        let tape = driver.run_primitive(&run.primitive, &actions)?;
        extend_validated_tape(&mut snapshots, &run, tape)?;
        action_offset += run.owned_actions.len();
        state = projected_state_after(scenario, &snapshots, retrieve, fixtures, action_offset)?;
    }
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
    let action_names = scenario_action_names(scenario);
    let runs = schedule_primitive_runs(&action_names, ownership)?;
    let action_steps = action_steps(scenario);
    let mut snapshots = vec![init];
    let mut action_offset = 0;
    let mut state = initial_projected_state(scenario, &snapshots, retrieve, fixtures)?;
    for run in runs {
        let snapshot = latest_snapshot(&snapshots)?;
        evaluate_run_pre_guards(
            scenario,
            action_offset,
            &state,
            snapshot,
            retrieve,
            fixtures,
        )?;
        let actions = resolve_run_actions(
            &run,
            &action_steps,
            action_offset,
            &state,
            snapshot,
            fixtures,
        )?;
        let tape = driver.run_primitive(&run.primitive, &actions).await?;
        extend_validated_tape(&mut snapshots, &run, tape)?;
        action_offset += run.owned_actions.len();
        state = projected_state_after(scenario, &snapshots, retrieve, fixtures, action_offset)?;
    }
    evaluate_refined_tape(scenario, &snapshots, retrieve, fixtures)
}

fn action_steps(scenario: &ArtifactScenario) -> Vec<&ArtifactStep> {
    scenario
        .steps
        .iter()
        .filter(|step| matches!(step, ArtifactStep::Action { .. }))
        .collect()
}

fn latest_snapshot<E>(snapshots: &[E]) -> Result<&E, String> {
    snapshots
        .last()
        .ok_or_else(|| "refinement snapshot tape has no initial fixture".to_owned())
}

struct ActionArgumentEvidence<'a, E> {
    state: &'a RuntimeValue,
    bound: BoundEvidence<'a, E>,
}

impl<E: NormalizedRuntimeEvidence> NormalizedRuntimeEvidence for ActionArgumentEvidence<'_, E> {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        if name == "state" {
            return Ok(self.state.clone());
        }
        self.bound.resolve_name(name)
    }

    fn resolve_call(
        &self,
        operator: &str,
        arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        self.bound.resolve_call(operator, arguments)
    }
}

fn resolve_run_actions<E: NormalizedRuntimeEvidence>(
    run: &crate::schedule::ScheduledPrimitiveRun,
    action_steps: &[&ArtifactStep],
    action_offset: usize,
    state: &RuntimeValue,
    snapshot: &E,
    fixtures: &FixtureTable,
) -> Result<Vec<ResolvedAction>, String> {
    let evidence = ActionArgumentEvidence {
        state,
        bound: BoundEvidence { fixtures, snapshot },
    };
    run.owned_actions
        .iter()
        .enumerate()
        .map(|(index, expected)| {
            let step = action_steps.get(action_offset + index).ok_or_else(|| {
                format!("primitive {} has no generated action step", run.primitive)
            })?;
            let ArtifactStep::Action { action, .. } = step else {
                unreachable!("action step list contains only actions")
            };
            if action != expected {
                return Err(format!(
                    "primitive {} expected generated action {expected} but found {action}",
                    run.primitive
                ));
            }
            Ok(ResolvedAction {
                name: action.clone(),
                arguments: evaluate_action_arguments(step, &evidence)?,
            })
        })
        .collect()
}

fn resolve_action<E: NormalizedRuntimeEvidence>(
    step: &ArtifactStep,
    state: &RuntimeValue,
    snapshot: &E,
    fixtures: &FixtureTable,
) -> Result<ResolvedAction, String> {
    let ArtifactStep::Action { action, .. } = step else {
        return Err("cannot resolve a non-action scenario step".to_owned());
    };
    let evidence = ActionArgumentEvidence {
        state,
        bound: BoundEvidence { fixtures, snapshot },
    };
    Ok(ResolvedAction {
        name: action.clone(),
        arguments: evaluate_action_arguments(step, &evidence)?,
    })
}

fn initial_projected_state<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    fixtures: &FixtureTable,
) -> Result<RuntimeValue, String> {
    projected_state_after(scenario, snapshots, retrieve, fixtures, 0)
}

fn projected_state_after<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    fixtures: &FixtureTable,
    action_count: usize,
) -> Result<RuntimeValue, String> {
    if scenario.initial_state.is_none() {
        return latest_snapshot(snapshots)?.resolve_name("state");
    }
    let bound = snapshots
        .iter()
        .map(|snapshot| BoundEvidence { fixtures, snapshot })
        .collect::<Vec<_>>();
    let extra = fixtures.retrieve_names();
    let mut bound_retrieve = retrieve.to_vec();
    bound_retrieve.extend(extra.iter().map(String::as_str));
    evaluate_projected_prefix_state(scenario, &bound, &bound_retrieve, action_count)
}

fn evaluate_run_pre_guards<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    action_offset: usize,
    state: &RuntimeValue,
    snapshot: &E,
    retrieve: &[&str],
    fixtures: &FixtureTable,
) -> Result<(), String> {
    if scenario.initial_state.is_none() {
        return Ok(());
    }
    let bound = BoundEvidence { fixtures, snapshot };
    let extra = fixtures.retrieve_names();
    let mut bound_retrieve = retrieve.to_vec();
    bound_retrieve.extend(extra.iter().map(String::as_str));
    evaluate_projected_pre_guards(scenario, action_offset, state, &bound, &bound_retrieve)?;
    Ok(())
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
    if scenario.initial_state.is_some() {
        evaluate_projected_action_steps(scenario, &bound, &bound_retrieve)
    } else {
        evaluate_all_action_steps(scenario, &bound, &bound_retrieve)
    }
}

/// Bind fixtures and evaluate final observations against the state accumulated
/// by [`evaluate_refined_tape`]'s Quint-owned reducer.
pub fn evaluate_refined_runtime_assertions<E: NormalizedRuntimeEvidence>(
    scenario: &ArtifactScenario,
    snapshots: &[E],
    retrieve: &[&str],
    fixtures: &FixtureTable,
    supported_dependencies: &[&str],
) -> Result<usize, String> {
    let bound = snapshots
        .iter()
        .map(|snapshot| BoundEvidence { fixtures, snapshot })
        .collect::<Vec<_>>();
    let extra = fixtures.retrieve_names();
    let mut bound_retrieve = retrieve.to_vec();
    bound_retrieve.extend(extra.iter().map(String::as_str));
    crate::evaluate::evaluate_projected_runtime_assertions(
        scenario,
        &bound,
        &bound_retrieve,
        supported_dependencies,
    )
}
