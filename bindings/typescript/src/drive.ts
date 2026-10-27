import { actionSteps, type ActionStep, type ArtifactScenario, scenarioId } from "./artifact.js";
import {
  evaluateActionArguments,
  evaluateAllActionSteps,
  evaluateProjectedActionStep,
  evaluateProjectedActionSteps,
  evaluateProjectedPreGuards,
  evaluateProjectedPrefixState,
  evaluateProjectedRuntimeAssertions,
} from "./evaluate.js";
import { isPromiseLike } from "./async.js";
import { fail } from "./error.js";
import type { Evidence } from "./evidence.js";
import { bindEvidence, type FixtureTable } from "./fixtures.js";
import type { OwnershipDescriptor } from "./ownership.js";
import { extendValidatedTape, type ScheduledPrimitiveRun, schedulePrimitiveRuns, scenarioActionNames } from "./schedule.js";
import { debugString, debugStrings, debugValues, type RuntimeValue } from "./value.js";

/** One generated Quint action with arguments normalized through fixtures. */
export interface ResolvedAction {
  /** The generated Quint action name. */
  readonly name: string;
  /** Arguments evaluated against the current reduced state and fixtures. */
  readonly arguments: readonly RuntimeValue[];
}

/** Renders one action in Rust's `Debug` notation, as divergence messages do. */
export function formatAction(action: ResolvedAction): string {
  return `ResolvedAction { name: ${debugString(action.name)}, arguments: ${debugValues(action.arguments)} }`;
}

/** Renders actions in Rust's `Debug` notation. */
export function formatActions(actions: readonly ResolvedAction[]): string {
  return `[${actions.map(formatAction).join(", ")}]`;
}

/** Renders strings in Rust's `Debug` notation: `["a", "b"]`. */
export function formatStrings(values: readonly string[]): string {
  return debugStrings(values);
}

/**
 * The domain plug-in: run one implementation primitive and return one snapshot
 * per refined step, in that order.
 *
 * Declare 1-to-N with `refines: [a, b, c]` on the ownership record. The driver
 * runs the impl command once and returns three evidences. Aliases are not a
 * sequence.
 */
export interface PrimitiveDriver {
  /** Executes `primitive` once and returns one snapshot per resolved action. */
  runPrimitive(primitive: string, actions: readonly ResolvedAction[]): readonly Evidence[];
}

/** The asynchronous form of {@link PrimitiveDriver}, for real process, socket or database commands. */
export interface AsyncPrimitiveDriver {
  runPrimitive(primitive: string, actions: readonly ResolvedAction[]): Promise<readonly Evidence[]> | readonly Evidence[];
}

/**
 * The domain plug-in for a generated scenario whose boundary is dispatched one
 * Quint action at a time.
 *
 * The returned evidence is a sparse observation of fields owned by that
 * action. The runner merges it into Quint's assigned state before resolving or
 * dispatching the next action.
 */
export interface ActionDriver {
  runAction(action: ResolvedAction): Evidence;
}

/** The asynchronous form of {@link ActionDriver}. */
export interface AsyncActionDriver {
  runAction(action: ResolvedAction): Promise<Evidence> | Evidence;
}

/** The evidence tape and obligation count produced by a stepwise run. */
export interface RefinementRun {
  /** The initial evidence followed by one recorded snapshot per action. */
  readonly snapshots: readonly Evidence[];
  /** The number of generated obligations evaluated during the run. */
  readonly evaluated: number;
}

function boundRetrieve(retrieve: readonly string[], fixtures: FixtureTable): string[] {
  return [...retrieve, ...fixtures.retrieveNames()];
}

function bindAll(snapshots: readonly Evidence[], fixtures: FixtureTable): Evidence[] {
  return snapshots.map(snapshot => bindEvidence(fixtures, snapshot));
}

/** Adds the reduced state to argument evaluation. */
function argumentEvidence(state: RuntimeValue, bound: Evidence): Evidence {
  return {
    resolveName: name => (name === "state" ? state : bound.resolveName(name)),
    resolveCall: (operator, args) => bound.resolveCall?.(operator, args),
  };
}

function resolveAction(step: ActionStep, state: RuntimeValue, snapshot: Evidence, fixtures: FixtureTable): ResolvedAction {
  const evidence = argumentEvidence(state, bindEvidence(fixtures, snapshot));
  return { name: step.action, arguments: evaluateActionArguments(step, evidence) };
}

/**
 * Resolves the generated action stream against the hydrated initial fixture.
 *
 * Drivers use this when a real boundary needs deterministic configuration from
 * the scenario (for example, connection IDs) before dispatch begins.
 */
export function resolveActionPlan(scenario: ArtifactScenario, init: Evidence, fixtures: FixtureTable): ResolvedAction[] {
  const bound = bindEvidence(fixtures, init);
  return actionSteps(scenario).map(step => ({ name: step.action, arguments: evaluateActionArguments(step, bound) }));
}

function projectedStateAfter(
  scenario: ArtifactScenario,
  snapshots: readonly Evidence[],
  retrieve: readonly string[],
  fixtures: FixtureTable,
  actionCount: number,
): RuntimeValue {
  if (scenario.initialState === undefined) {
    const latest = snapshots[snapshots.length - 1]!;
    return latest.resolveName("state") ?? fail("unknown evidence name state");
  }
  return evaluateProjectedPrefixState(scenario, bindAll(snapshots, fixtures), boundRetrieve(retrieve, fixtures), actionCount);
}

function evaluateRunPreGuards(
  scenario: ArtifactScenario,
  actionOffset: number,
  state: RuntimeValue,
  snapshot: Evidence,
  retrieve: readonly string[],
  fixtures: FixtureTable,
): void {
  if (scenario.initialState !== undefined) {
    evaluateProjectedPreGuards(scenario, actionOffset, state, bindEvidence(fixtures, snapshot), boundRetrieve(retrieve, fixtures));
  }
}

/**
 * A stateful reducer for runners whose live resources stay in a local harness.
 *
 * `nextAction` validates pre-guards and resolves arguments. `record` merges the
 * sparse observation and validates the post-state before another generated
 * action can be requested.
 */
export class RefinementSession {
  private readonly scenario: ArtifactScenario;
  private readonly retrieve: readonly string[];
  private readonly fixtures: FixtureTable;
  private readonly steps: readonly ActionStep[];
  private readonly snapshots: Evidence[];
  private state: RuntimeValue;
  private nextIndex = 0;
  private evaluated = 0;
  private awaitingObservation = false;

  /** Starts a session from generated initial state and runtime evidence. */
  constructor(scenario: ArtifactScenario, init: Evidence, retrieve: readonly string[], fixtures: FixtureTable) {
    this.scenario = scenario;
    this.retrieve = retrieve;
    this.fixtures = fixtures;
    this.snapshots = [init];
    this.state = projectedStateAfter(scenario, this.snapshots, retrieve, fixtures, 0);
    this.steps = actionSteps(scenario);
  }

  /**
   * Validates the current prefix and resolves the next action for dispatch.
   * It returns `undefined` when every generated action has been recorded.
   */
  nextAction(): ResolvedAction | undefined {
    if (this.awaitingObservation) {
      return fail("record the preceding Rust action observation before requesting another action");
    }
    const step = this.steps[this.nextIndex];
    if (step === undefined) {
      return undefined;
    }
    const snapshot = this.snapshots[this.snapshots.length - 1]!;
    evaluateRunPreGuards(this.scenario, this.nextIndex, this.state, snapshot, this.retrieve, this.fixtures);
    const action = resolveAction(step, this.state, snapshot, this.fixtures);
    this.awaitingObservation = true;
    return action;
  }

  /** Records sparse implementation evidence and reduces the generated next state. */
  record(evidence: Evidence): void {
    if (!this.awaitingObservation) {
      return fail("cannot record Rust evidence without a dispatched generated action");
    }
    this.snapshots.push(evidence);
    const step = this.steps[this.nextIndex]!;
    const before = bindEvidence(this.fixtures, this.snapshots[this.nextIndex]!);
    const after = bindEvidence(this.fixtures, this.snapshots[this.nextIndex + 1]!);
    const result = evaluateProjectedActionStep(
      scenarioId(this.scenario),
      step.action,
      step.guards,
      step.next,
      this.state,
      before,
      after,
      boundRetrieve(this.retrieve, this.fixtures),
    );
    this.evaluated += result.evaluated;
    this.state = result.state;
    this.nextIndex += 1;
    this.awaitingObservation = false;
  }

  /** Completes the session after every generated action has been recorded. */
  finish(): RefinementRun {
    if (this.awaitingObservation) {
      return fail("generated action was dispatched without a Rust observation");
    }
    if (this.nextIndex !== this.steps.length) {
      return fail(`${scenarioId(this.scenario)} stopped after ${this.nextIndex} of ${this.steps.length} generated actions`);
    }
    return { snapshots: this.snapshots, evaluated: this.evaluated };
  }
}

/**
 * Hydrates a fixture from Quint and dispatches the generated scenario one
 * action at a time.
 *
 * Each action's pre-guards and arguments use the accumulated state from the
 * preceding prefix. The action returns only its observed subset; Quint's
 * assignment supplies the rest of the next state. Post-guards and `next` are
 * evaluated before the following action is allowed to run.
 */
export function runRefinedActions(
  scenario: ArtifactScenario,
  init: Evidence,
  retrieve: readonly string[],
  fixtures: FixtureTable,
  driver: ActionDriver,
): RefinementRun {
  const session = new RefinementSession(scenario, init, retrieve, fixtures);
  for (let action = session.nextAction(); action !== undefined; action = session.nextAction()) {
    const evidence = driver.runAction(action);
    if (isPromiseLike(evidence)) {
      return fail(`action ${action.name} returned a promise; use runRefinedActionsAsync`);
    }
    session.record(evidence);
  }
  return session.finish();
}

/** The asynchronous form of {@link runRefinedActions}. */
export async function runRefinedActionsAsync(
  scenario: ArtifactScenario,
  init: Evidence,
  retrieve: readonly string[],
  fixtures: FixtureTable,
  driver: AsyncActionDriver,
): Promise<RefinementRun> {
  const session = new RefinementSession(scenario, init, retrieve, fixtures);
  for (let action = session.nextAction(); action !== undefined; action = session.nextAction()) {
    session.record(await driver.runAction(action));
  }
  return session.finish();
}

/** The scheduling and reduction shared by the synchronous and asynchronous primitive loops. */
class PrimitiveRefinement {
  private readonly scenario: ArtifactScenario;
  private readonly retrieve: readonly string[];
  private readonly fixtures: FixtureTable;
  private readonly runs: readonly ScheduledPrimitiveRun[];
  private readonly steps: readonly ActionStep[];
  private snapshots: Evidence[];
  private actionOffset = 0;
  private runIndex = 0;
  private state: RuntimeValue;

  constructor(
    scenario: ArtifactScenario,
    init: Evidence,
    ownership: readonly OwnershipDescriptor[],
    retrieve: readonly string[],
    fixtures: FixtureTable,
  ) {
    this.scenario = scenario;
    this.retrieve = retrieve;
    this.fixtures = fixtures;
    this.runs = schedulePrimitiveRuns(scenarioActionNames(scenario), ownership);
    this.steps = actionSteps(scenario);
    this.snapshots = [init];
    this.state = projectedStateAfter(scenario, this.snapshots, retrieve, fixtures, 0);
  }

  /** Validates pre-guards and resolves the next primitive's actions, or returns `undefined` when none remain. */
  next(): { run: ScheduledPrimitiveRun; actions: ResolvedAction[] } | undefined {
    const run = this.runs[this.runIndex];
    if (run === undefined) {
      return undefined;
    }
    const snapshot = this.snapshots[this.snapshots.length - 1]!;
    evaluateRunPreGuards(this.scenario, this.actionOffset, this.state, snapshot, this.retrieve, this.fixtures);
    const evidence = argumentEvidence(this.state, bindEvidence(this.fixtures, snapshot));
    const actions = run.ownedActions.map((expected, index) => {
      const step = this.steps[this.actionOffset + index];
      if (step === undefined) {
        return fail(`primitive ${run.primitive} has no generated action step`);
      }
      if (step.action !== expected) {
        return fail(`primitive ${run.primitive} expected generated action ${expected} but found ${step.action}`);
      }
      return { name: step.action, arguments: evaluateActionArguments(step, evidence) };
    });
    return { run, actions };
  }

  /** Validates the tape a primitive returned and advances the reduced state. */
  record(run: ScheduledPrimitiveRun, tape: readonly Evidence[]): void {
    this.snapshots = extendValidatedTape(this.snapshots, run, tape);
    this.actionOffset += run.ownedActions.length;
    this.runIndex += 1;
    this.state = projectedStateAfter(this.scenario, this.snapshots, this.retrieve, this.fixtures, this.actionOffset);
  }

  finish(): number {
    return evaluateRefinedTape(this.scenario, this.snapshots, this.retrieve, this.fixtures);
  }
}

/**
 * Walks the generated JSON through ownership records, runs each primitive
 * once, and evaluates every guard and next conjunct on the resulting tape.
 *
 * `fixtures` owns Quint names (`Idle`, `attemptA`, universe sets). Snapshots
 * own live `state`. Model-scope conjuncts are not skipped. It returns the
 * number of obligations evaluated, and throws a `RefinementError` naming the
 * first divergence.
 */
export function refineScenario(
  scenario: ArtifactScenario,
  init: Evidence,
  ownership: readonly OwnershipDescriptor[],
  retrieve: readonly string[],
  fixtures: FixtureTable,
  driver: PrimitiveDriver,
): number {
  const refinement = new PrimitiveRefinement(scenario, init, ownership, retrieve, fixtures);
  for (let pending = refinement.next(); pending !== undefined; pending = refinement.next()) {
    const tape = driver.runPrimitive(pending.run.primitive, pending.actions);
    if (isPromiseLike(tape)) {
      return fail(`primitive ${pending.run.primitive} returned a promise; use refineScenarioAsync`);
    }
    refinement.record(pending.run, tape);
  }
  return refinement.finish();
}

/**
 * The asynchronous form of {@link refineScenario} for production boundaries.
 *
 * Scheduling and tape cardinality use the same checks as the synchronous loop.
 * Primitives run sequentially because each retrieve-before snapshot is the
 * preceding action's retrieve-after snapshot.
 */
export async function refineScenarioAsync(
  scenario: ArtifactScenario,
  init: Evidence,
  ownership: readonly OwnershipDescriptor[],
  retrieve: readonly string[],
  fixtures: FixtureTable,
  driver: AsyncPrimitiveDriver,
): Promise<number> {
  const refinement = new PrimitiveRefinement(scenario, init, ownership, retrieve, fixtures);
  for (let pending = refinement.next(); pending !== undefined; pending = refinement.next()) {
    refinement.record(pending.run, await driver.runPrimitive(pending.run.primitive, pending.actions));
  }
  return refinement.finish();
}

/**
 * Binds fixtures in front of an already-collected snapshot tape and evaluates
 * every guard and next conjunct.
 */
export function evaluateRefinedTape(
  scenario: ArtifactScenario,
  snapshots: readonly Evidence[],
  retrieve: readonly string[],
  fixtures: FixtureTable,
): number {
  const bound = bindAll(snapshots, fixtures);
  const supported = boundRetrieve(retrieve, fixtures);
  return scenario.initialState !== undefined
    ? evaluateProjectedActionSteps(scenario, bound, supported)
    : evaluateAllActionSteps(scenario, bound, supported);
}

/**
 * Binds fixtures and evaluates final observations against the state
 * accumulated by {@link evaluateRefinedTape}'s Quint-owned reducer.
 */
export function evaluateRefinedRuntimeAssertions(
  scenario: ArtifactScenario,
  snapshots: readonly Evidence[],
  retrieve: readonly string[],
  fixtures: FixtureTable,
  supportedDependencies: readonly string[],
): number {
  return evaluateProjectedRuntimeAssertions(scenario, bindAll(snapshots, fixtures), boundRetrieve(retrieve, fixtures), supportedDependencies);
}
