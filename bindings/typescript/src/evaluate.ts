import type { ActionStep, ArtifactAssertion, ArtifactScenario, ArtifactStep } from "./artifact.js";
import { actionSteps, scenarioId } from "./artifact.js";
import { fail, RefinementError } from "./error.js";
import type { Evidence } from "./evidence.js";
import { field as jsonField, type Json, jsonString, kindOf } from "./json.js";
import {
  absent,
  bool,
  debug,
  debugStrings,
  debugString,
  debugValues,
  equal,
  fromItfJson,
  int,
  list,
  map,
  mapGet,
  mapWith,
  present,
  record,
  recordWith,
  set,
  setContains,
  text,
  tuple,
  type RuntimeValue,
  variant,
} from "./value.js";

type Environment = ReadonlyMap<string, RuntimeValue>;

interface AssignmentSink {
  value?: RuntimeValue;
}

interface Eval {
  readonly current: Evidence;
  readonly before: Evidence;
  readonly after: Evidence;
  readonly sink?: AssignmentSink;
}

const emptyEnvironment: Environment = new Map();

function extend(environment: Environment, name: string, value: RuntimeValue): Environment {
  const nested = new Map(environment);
  nested.set(name, value);
  return nested;
}

function allSame(evidence: Evidence): Eval {
  return { current: evidence, before: evidence, after: evidence };
}

function resolveName(evidence: Evidence, name: string): RuntimeValue {
  return evidence.resolveName(name) ?? fail(`unknown evidence name ${name}`);
}

/**
 * Resolves one generated action's Quint arguments against hydrated fixtures
 * and the current scenario state.
 */
export function evaluateActionArguments(step: ArtifactStep, evidence: Evidence): RuntimeValue[] {
  if (step.kind !== "action") {
    return fail("only action steps have runtime arguments");
  }
  const ev = allSame(evidence);
  return step.arguments.map(argument => {
    try {
      return evaluate(argument, ev, emptyEnvironment);
    } catch (error) {
      throw wrap(`${step.action} argument: `, error);
    }
  });
}

function wrap(prefix: string, error: unknown): unknown {
  return error instanceof RefinementError ? new RefinementError(`${prefix}${error.message}`) : error;
}

/**
 * Evaluates every non-model assertion in a checked scenario's observe steps.
 *
 * Evaluation fails closed when an assertion references a dependency outside
 * the adapter's declared registry or uses unsupported normalized syntax.
 */
export function evaluateRuntimeAssertions(
  scenario: ArtifactScenario,
  evidence: Evidence,
  supportedDependencies: readonly string[],
): number {
  let evaluated = 0;
  for (const step of scenario.steps) {
    if (step.kind === "observe") {
      evaluated += evaluateAssertions(scenarioId(scenario), "observe", step.assertions, allSame(evidence), supportedDependencies, true);
    }
  }
  if (evaluated === 0) {
    return fail(`${scenarioId(scenario)} evaluated no runtime assertions`);
  }
  return evaluated;
}

/**
 * Evaluates guard assertions on the retrieve-before snapshot and next-state
 * assertions on the retrieve-after snapshot for one action step. Model-scope
 * conjuncts are skipped. Prefer {@link evaluateAllStepObligations} once the
 * scenario's Quint names have fixture owners.
 */
export function evaluateStepObligations(
  scenarioName: string,
  action: string,
  guards: readonly ArtifactAssertion[],
  next: readonly ArtifactAssertion[],
  before: Evidence,
  after: Evidence,
  retrieve: readonly string[],
): number {
  return stepObligations(scenarioName, action, guards, next, before, after, retrieve, true);
}

/** Like {@link evaluateStepObligations}, but every guard and next conjunct runs, model scope included. */
export function evaluateAllStepObligations(
  scenarioName: string,
  action: string,
  guards: readonly ArtifactAssertion[],
  next: readonly ArtifactAssertion[],
  before: Evidence,
  after: Evidence,
  retrieve: readonly string[],
): number {
  return stepObligations(scenarioName, action, guards, next, before, after, retrieve, false);
}

/** Evaluates each observe chapter's preceding action `next` against the same evidence used for that observe. */
export function evaluateChapterNext(scenario: ArtifactScenario, evidence: Evidence, retrieve: readonly string[]): number {
  let evaluated = 0;
  scenario.steps.forEach((step, index) => {
    if (step.kind === "observe") {
      evaluated += evaluatePrecedingActionNext(scenario, index, evidence, retrieve);
    }
  });
  return evaluated;
}

/** Evaluates `next` on the last action before `observeIndex`. */
export function evaluatePrecedingActionNext(
  scenario: ArtifactScenario,
  observeIndex: number,
  evidence: Evidence,
  retrieve: readonly string[],
): number {
  for (let index = observeIndex - 1; index >= 0; index -= 1) {
    const step = scenario.steps[index]!;
    if (step.kind !== "action") {
      continue;
    }
    if (step.next.length === 0) {
      return 0;
    }
    return evaluateStepObligations(scenarioId(scenario), step.action, [], step.next, evidence, evidence, retrieve);
  }
  return 0;
}

/**
 * The strict fake-domain loop: `snapshots[0]` is retrieve-before the first
 * action and `snapshots[i + 1]` is retrieve-after action `i`. It fails if the
 * snapshot count is not the action count plus one. Model-scope conjuncts are
 * skipped.
 */
export function evaluateEveryActionStep(scenario: ArtifactScenario, snapshots: readonly Evidence[], retrieve: readonly string[]): number {
  return actionStepObligations(scenario, snapshots, retrieve, true);
}

/**
 * Like {@link evaluateEveryActionStep}, but every guard and next conjunct
 * runs. Fixture-backed names belong on `retrieve` as `name:<fixture>`.
 */
export function evaluateAllActionSteps(scenario: ArtifactScenario, snapshots: readonly Evidence[], retrieve: readonly string[]): number {
  return actionStepObligations(scenario, snapshots, retrieve, false);
}

/**
 * Evaluates a complete scenario as a reducer over its generated action tape.
 *
 * The generated Quint initial state is hydrated once into a `RuntimeValue`.
 * Each generated action assignment advances that hydrated state;
 * implementation evidence overlays only the state fields claimed by the
 * retrieve contract. Pre-guards evaluate before the assignment and the
 * implementation action, while assignment guards and every `next` conjunct
 * evaluate against the merged state after it.
 */
export function evaluateProjectedActionSteps(scenario: ArtifactScenario, snapshots: readonly Evidence[], retrieve: readonly string[]): number {
  return projectedActionSteps(scenario, snapshots, retrieve, true).evaluated;
}

/** Evaluates final scenario observations against the same accumulated state produced by the action reducer. */
export function evaluateProjectedRuntimeAssertions(
  scenario: ArtifactScenario,
  snapshots: readonly Evidence[],
  retrieve: readonly string[],
  supportedDependencies: readonly string[],
): number {
  const actionTotal = actionSteps(scenario).length;
  if (snapshots.length !== actionTotal + 1) {
    return fail(`${scenarioId(scenario)} has ${actionTotal} actions but ${snapshots.length} snapshots`);
  }
  let actionCount = 0;
  let evaluated = 0;
  for (const step of scenario.steps) {
    if (step.kind === "action") {
      actionCount += 1;
    } else if (step.kind === "observe") {
      const state = evaluateProjectedPrefixState(scenario, snapshots.slice(0, actionCount + 1), retrieve, actionCount);
      const chapter: ArtifactScenario = { ...scenario, steps: [step] };
      evaluated += evaluateRuntimeAssertions(chapter, projected(snapshots[actionCount]!, state), supportedDependencies);
    }
  }
  if (evaluated === 0) {
    return fail(`${scenarioId(scenario)} evaluated no runtime assertions`);
  }
  return evaluated;
}

/** The accumulated model state after the first `actionCount` actions. */
export function evaluateProjectedPrefixState(
  scenario: ArtifactScenario,
  snapshots: readonly Evidence[],
  retrieve: readonly string[],
  actionCount: number,
): RuntimeValue {
  const steps: ArtifactStep[] = [];
  let retained = 0;
  for (const step of scenario.steps) {
    if (step.kind === "init") {
      steps.push(step);
    } else if (step.kind === "action" && retained < actionCount) {
      retained += 1;
      steps.push(step);
    }
  }
  return projectedActionSteps({ ...scenario, steps }, snapshots, retrieve, false).state;
}

/** Evaluates the guards that do not assign state, before the implementation action runs. */
export function evaluateProjectedPreGuards(
  scenario: ArtifactScenario,
  actionIndex: number,
  state: RuntimeValue,
  snapshot: Evidence,
  retrieve: readonly string[],
): number {
  const step = actionSteps(scenario)[actionIndex];
  if (step === undefined) {
    return fail(`${scenarioId(scenario)} has no action ${actionIndex}`);
  }
  const preGuards = step.guards.filter(guard => !containsAssignment(guard.expression));
  const before = projected(snapshot, state);
  return evaluateAssertions(`${scenarioId(scenario)}:${step.action}`, "pre-guard", preGuards, allSame(before), retrieve, false);
}

function projectedActionSteps(
  scenario: ArtifactScenario,
  snapshots: readonly Evidence[],
  retrieve: readonly string[],
  requireObligations: boolean,
): { evaluated: number; state: RuntimeValue } {
  const id = scenarioId(scenario);
  const actions = actionSteps(scenario);
  if (snapshots.length !== actions.length + 1) {
    return fail(`${id} has ${actions.length} actions but ${snapshots.length} snapshots (want init plus one after each action)`);
  }
  if (scenario.initialState === undefined) {
    return fail(`${id} has no complete initial state`);
  }
  let state: RuntimeValue;
  try {
    state = fromItfJson(scenario.initialState);
  } catch (error) {
    throw wrap(`${id} initial state: `, error);
  }
  let initialObserved: RuntimeValue;
  try {
    initialObserved = resolveName(snapshots[0]!, "state");
  } catch (error) {
    throw wrap(`${id} init state evidence: `, error);
  }
  if (!structurallyEqual(state, initialObserved)) {
    const difference = structuralDifference(state, initialObserved, "state") ?? "normalized values differ";
    return fail(`${id} Rust fixture does not match Quint initial state: ${difference}`);
  }
  let evaluated = 0;
  actions.forEach((action, index) => {
    const result = evaluateProjectedActionStep(id, action.action, action.guards, action.next, state, snapshots[index]!, snapshots[index + 1]!, retrieve);
    evaluated += result.evaluated;
    state = result.state;
  });
  if (requireObligations && evaluated === 0) {
    return fail(`${id} evaluated no action obligations`);
  }
  return { evaluated, state };
}

/**
 * Evaluates one complete action: pre-guards, the model's state assignment,
 * the merge with the implementation's observed fields, then post-guards and
 * every `next` conjunct against the merged state.
 */
export function evaluateProjectedActionStep(
  scenarioName: string,
  action: string,
  guards: readonly ArtifactAssertion[],
  next: readonly ArtifactAssertion[],
  state: RuntimeValue,
  beforeSnapshot: Evidence,
  afterSnapshot: Evidence,
  retrieve: readonly string[],
): { evaluated: number; state: RuntimeValue } {
  const context = `${scenarioName}:${action}`;
  const before = projected(beforeSnapshot, state);
  const preGuards = guards.filter(guard => !containsAssignment(guard.expression));
  const postGuards = guards.filter(guard => containsAssignment(guard.expression));
  let evaluated = evaluateAssertions(context, "pre-guard", preGuards, allSame(before), retrieve, false);

  const sink: AssignmentSink = {};
  const capture: Eval = { current: before, before, after: before, sink };
  let assignmentKind = "";
  let assignment: ArtifactAssertion | undefined;
  const guardAssignment = guards.find(guard => containsAssignment(guard.expression));
  if (guardAssignment !== undefined) {
    assignmentKind = "post-guard";
    assignment = guardAssignment;
  } else {
    assignment = next.find(conjunct => containsAssignment(conjunct.expression));
    assignmentKind = "next";
  }
  if (assignment === undefined) {
    return fail(`${context} next: complete action has no state assignment`);
  }
  evaluateAssertions(context, assignmentKind, [assignment], capture, retrieve, false);
  if (sink.value === undefined) {
    return fail(`${context} next: complete action has no state assignment`);
  }
  const modelNext = sink.value;
  let observed: RuntimeValue;
  try {
    observed = resolveName(afterSnapshot, "state");
  } catch (error) {
    throw wrap(`${context} state evidence: `, error);
  }
  const observedFields = new Set<string>();
  for (const assertion of [...guards, ...next]) {
    if (assertion.scope !== "runtime") {
      continue;
    }
    for (const dependency of assertion.dependencies) {
      if (dependency.startsWith("path:state.")) {
        observedFields.add(dependency.slice("path:state.".length).split(".")[0]!);
      }
    }
  }
  try {
    requireChangedObservations(state, modelNext, observed, observedFields);
  } catch (error) {
    throw wrap(`${context} state evidence: `, error);
  }
  const mergedFields = observedStateFields(retrieve);
  for (const name of observedFields) {
    mergedFields.add(name);
  }
  const merged = mergeObservedState(modelNext, observed, mergedFields);
  const after = projected(afterSnapshot, merged);
  evaluated += evaluateAssertions(context, "post-guard", postGuards, { current: before, before, after }, retrieve, false);
  evaluated += evaluateAssertions(context, "next", next, { current: after, before, after }, retrieve, false);
  return { evaluated, state: merged };
}

/** Evidence whose `state` is the reducer's accumulated state and whose other names come from a snapshot. */
function projected(snapshot: Evidence, state: RuntimeValue): Evidence {
  return {
    resolveName: name => (name === "state" ? state : snapshot.resolveName(name)),
    resolveCall: (operator, args) => projectedCall(snapshot, state, operator, args),
  };
}

function projectedCall(snapshot: Evidence, state: RuntimeValue, operator: string, args: readonly RuntimeValue[]): RuntimeValue | undefined {
  const argument = args[0];
  if (operator === "dedupEntry" && args.length === 1) {
    return projectedOptionalMapValue(state, "connector_dedup", argument!);
  }
  if (operator === "dedupValue" && args.length === 1) {
    const value = projectedOptionalMapValue(state, "connector_dedup", argument!);
    if (value.kind === "present") {
      return value.value;
    }
    if (value.kind === "absent") {
      return fail("projected connector_dedup entry is absent");
    }
    return value;
  }
  if (operator === "resultFor" && args.length === 2 && argument?.kind === "record") {
    const delivery = argument.fields;
    const read = (name: string): RuntimeValue => delivery.get(name) ?? fail(`deliveryValue has no ${name}`);
    const result: [string, RuntimeValue][] = [];
    for (const [target, source] of [
      ["attempt_id", "attempt_id"],
      ["delivery_id", "id"],
      ["org_id", "org_id"],
      ["service_spec_id", "service_spec_id"],
      ["service_id", "service_id"],
      ["connection_id", "connection_id"],
    ] as const) {
      result.push([target, read(source)]);
    }
    result.push(["outcome", args[1]!]);
    return record(result);
  }
  const collection = (
    { attemptValue: "attempts", connectionValue: "connections", deliveryValue: "deliveries", tokenValue: "enrollment_tokens" } as Record<string, string | undefined>
  )[operator];
  if (collection !== undefined && args.length === 1) {
    return projectedMapValue(state, collection, argument!);
  }
  return snapshot.resolveCall?.(operator, args);
}

function projectedOptionalMapValue(state: RuntimeValue, fieldName: string, key: RuntimeValue): RuntimeValue {
  if (state.kind !== "record") {
    return fail("projected state is not a record");
  }
  const values = state.fields.get(fieldName);
  if (values?.kind !== "map") {
    return fail(`projected state has no map ${fieldName}`);
  }
  return mapGet(values, key) ?? absent;
}

function projectedMapValue(state: RuntimeValue, fieldName: string, key: RuntimeValue): RuntimeValue {
  if (state.kind !== "record") {
    return fail("projected state is not a record");
  }
  const collection = state.fields.get(fieldName);
  let value: RuntimeValue | undefined;
  if (collection?.kind === "map") {
    value = mapGet(collection, key);
  } else if (collection?.kind === "record") {
    if (key.kind !== "text") {
      return fail(`projected state has no keyed collection ${fieldName}`);
    }
    value = collection.fields.get(key.value);
  } else {
    return fail(`projected state has no keyed collection ${fieldName}`);
  }
  if (value === undefined || value.kind === "absent") {
    return fail(`projected ${fieldName} has no value for ${debug(key)}`);
  }
  return value.kind === "present" ? value.value : value;
}

function observedStateFields(retrieve: readonly string[]): Set<string> {
  const fields = new Set<string>();
  for (const dependency of retrieve) {
    if (dependency.startsWith("path:state.")) {
      fields.add(dependency.slice("path:state.".length).split(".")[0]!);
    }
  }
  return fields;
}

function containsAssignment(expression: Json | undefined): boolean {
  if (kindOf(expression) === "call" && jsonField(expression, "operator") === "assign") {
    return true;
  }
  if (Array.isArray(expression)) {
    return (expression as readonly Json[]).some(containsAssignment);
  }
  if (expression !== null && typeof expression === "object") {
    return Object.values(expression).some(containsAssignment);
  }
  return false;
}

function mergeObservedState(model: RuntimeValue, observed: RuntimeValue, fields: ReadonlySet<string>): RuntimeValue {
  if (model.kind !== "record") {
    return fail("generated Quint state is not a record");
  }
  if (observed.kind !== "record") {
    return fail("Rust action state evidence is not a record");
  }
  const merged = new Map(model.fields);
  for (const name of [...fields].sort()) {
    const value = observed.fields.get(name);
    if (value === undefined) {
      continue;
    }
    const modelValue = merged.get(name);
    if (modelValue === undefined) {
      return fail(`Rust action evidence contains field state.${name} outside the hydrated Quint state`);
    }
    merged.set(name, mergeStateValue(modelValue, value));
  }
  return record(merged);
}

function requireChangedObservations(
  before: RuntimeValue,
  modelNext: RuntimeValue,
  observed: RuntimeValue,
  fields: ReadonlySet<string>,
): void {
  if (before.kind !== "record" || modelNext.kind !== "record") {
    return fail("generated Quint state is not a record");
  }
  if (observed.kind !== "record") {
    return fail("Rust action state evidence is not a record");
  }
  for (const name of [...fields].sort()) {
    const left = before.fields.get(name);
    const right = modelNext.fields.get(name);
    const changed = (left === undefined) !== (right === undefined) || (left !== undefined && right !== undefined && !equal(left, right));
    if (changed && !observed.fields.has(name)) {
      return fail(`Rust action omitted changed runtime-owned field state.${name}`);
    }
  }
}

/** Overlays `update` onto `accumulated` without modifying either. */
function mergeStateValue(accumulated: RuntimeValue, update: RuntimeValue): RuntimeValue {
  switch (accumulated.kind) {
    case "map":
      if (update.kind === "map") {
        let result = accumulated;
        for (const [key, value] of update.entries) {
          const existing = mapGet(result, key);
          result = mapWith(result, key, existing === undefined ? value : mergeStateValue(existing, value));
        }
        return result;
      }
      if (update.kind === "record") {
        let result = accumulated;
        for (const [name, value] of update.fields) {
          const key = text(name);
          const existing = mapGet(result, key);
          result = mapWith(result, key, existing === undefined ? value : mergeStateValue(existing, value));
        }
        return result;
      }
      break;
    case "record":
      if (update.kind === "record") {
        const result = new Map(accumulated.fields);
        for (const [name, value] of update.fields) {
          const existing = result.get(name);
          result.set(name, existing === undefined ? value : mergeStateValue(existing, value));
        }
        return record(result);
      }
      break;
    case "list":
      if (update.kind === "list" && accumulated.items.length === update.items.length) {
        return list(accumulated.items.map((item, index) => mergeStateValue(item, update.items[index]!)));
      }
      break;
    case "tuple":
      if (update.kind === "tuple" && accumulated.items.length === update.items.length) {
        return tuple(accumulated.items.map((item, index) => mergeStateValue(item, update.items[index]!)));
      }
      break;
    case "variant":
      if (update.kind === "variant" && accumulated.tag === update.tag) {
        return variant(accumulated.tag, mergeStateValue(accumulated.value, update.value));
      }
      break;
    case "present":
      if (update.kind === "present") {
        return present(mergeStateValue(accumulated.value, update.value));
      }
      break;
    default:
      break;
  }
  return update;
}

function actionStepObligations(scenario: ArtifactScenario, snapshots: readonly Evidence[], retrieve: readonly string[], skipModel: boolean): number {
  const actions = actionSteps(scenario);
  if (snapshots.length !== actions.length + 1) {
    return fail(`${scenarioId(scenario)} has ${actions.length} actions but ${snapshots.length} snapshots (want init plus one after each action)`);
  }
  let evaluated = 0;
  actions.forEach((step: ActionStep, index) => {
    evaluated += stepObligations(scenarioId(scenario), step.action, step.guards, step.next, snapshots[index]!, snapshots[index + 1]!, retrieve, skipModel);
  });
  return evaluated;
}

function stepObligations(
  scenarioName: string,
  action: string,
  guards: readonly ArtifactAssertion[],
  next: readonly ArtifactAssertion[],
  before: Evidence,
  after: Evidence,
  retrieve: readonly string[],
  skipModel: boolean,
): number {
  if (guards.length === 0 && next.length === 0) {
    return 0;
  }
  const context = `${scenarioName}:${action}`;
  const evaluated =
    evaluateAssertions(context, "guard", guards, { current: before, before, after }, retrieve, skipModel) +
    evaluateAssertions(context, "next", next, { current: after, before, after }, retrieve, skipModel);
  if (evaluated === 0) {
    return fail(`${context} declared step obligations but evaluated none`);
  }
  return evaluated;
}

function evaluateAssertions(
  context: string,
  kind: string,
  assertions: readonly ArtifactAssertion[],
  ev: Eval,
  supported: readonly string[],
  skipModel: boolean,
): number {
  let evaluated = 0;
  for (const assertion of assertions) {
    if (skipModel && assertion.scope === "model") {
      continue;
    }
    for (const dependency of assertion.dependencies) {
      if (!dependencyIsSupported(dependency, supported)) {
        return fail(`${context} ${kind} uses unsupported runtime dependency ${dependency}`);
      }
    }
    let value: RuntimeValue;
    try {
      value = evaluate(assertion.expression, ev, emptyEnvironment);
    } catch (error) {
      throw wrap(`${context} ${kind}: `, error);
    }
    if (value.kind !== "bool") {
      return fail(`${kind} assertion did not evaluate to boolean in ${context}: ${jsonString(assertion.expression)}`);
    }
    if (!value.value) {
      return fail(`${kind} assertion evaluated false in ${context}: ${jsonString(assertion.expression)}`);
    }
    evaluated += 1;
  }
  return evaluated;
}

const builtinDependencies = new Set([
  "operator:eq",
  "operator:neq",
  "operator:not",
  "operator:actionAll",
  "operator:contains",
  "operator:field",
  "operator:get",
  "operator:assign",
]);

function dependencyIsSupported(dependency: string, supported: readonly string[]): boolean {
  return builtinDependencies.has(dependency) || supported.includes(dependency);
}

/** Evaluates one normalized expression tree. Exported for tests of individual operators. */
export function evaluateExpression(
  expression: Json | undefined,
  evidence: Evidence,
  environment: ReadonlyMap<string, RuntimeValue> = emptyEnvironment,
): RuntimeValue {
  return evaluate(expression, allSame(evidence), environment);
}

function evaluate(expression: Json | undefined, ev: Eval, env: Environment): RuntimeValue {
  switch (kindOf(expression)) {
    case "bool": {
      const value = jsonField(expression, "value");
      return typeof value === "boolean" ? bool(value) : fail("normalized boolean has no value");
    }
    case "int": {
      const value = jsonField(expression, "value");
      return typeof value === "bigint" ? int(value) : fail("normalized integer has no value");
    }
    case "str": {
      const value = jsonField(expression, "value");
      return typeof value === "string" ? text(value) : fail("normalized string has no value");
    }
    case "name": {
      const name = jsonField(expression, "value");
      if (typeof name !== "string") {
        return fail("normalized name has no value");
      }
      const bound = env.get(name);
      if (bound !== undefined) {
        return bound;
      }
      if (name === "disabled") {
        return bool(false);
      }
      if (name === "Absent") {
        try {
          return ev.current.resolveName(name) ?? absent;
        } catch {
          return absent;
        }
      }
      return resolveName(ev.current, name);
    }
    case "call":
      return evaluateCall(expression, ev, env);
    case "let": {
      const name = jsonField(expression, "name");
      if (typeof name !== "string") {
        return fail("normalized let has no name");
      }
      const value = evaluate(jsonField(expression, "value"), ev, env);
      return evaluate(jsonField(expression, "body"), ev, extend(env, name, value));
    }
    default:
      return fail("unsupported normalized expression kind");
  }
}

function evaluateCall(expression: Json | undefined, ev: Eval, env: Environment): RuntimeValue {
  const operator = jsonField(expression, "operator");
  if (typeof operator !== "string") {
    return fail("normalized call has no operator");
  }
  const rawArguments = jsonField(expression, "arguments");
  if (!Array.isArray(rawArguments)) {
    return fail("normalized call has no arguments");
  }
  const args = rawArguments as readonly Json[];
  switch (operator) {
    case "assign":
      return evaluateAssign(args, ev, env);
    case "matchVariant":
      return evaluateMatchVariant(args, ev, env);
    case "filter":
      return evaluateFilter(args, ev, env);
    case "map":
    case "mapBy":
      return evaluateMap(operator, args, ev, env);
    case "fold":
      return evaluateFold(args, ev, env);
    case "forall":
    case "exists":
      return evaluateQuantifier(operator, args, ev, env);
    case "ite":
      return evaluateIte(args, ev, env);
    case "and":
    case "or":
    case "actionAll":
    case "actionAny":
      return evaluateShortCircuit(operator, args, ev, env);
    default:
      break;
  }
  const values = args.map(argument => evaluate(argument, ev, env));
  const builtin = commonCall(operator, values);
  if (builtin !== undefined) {
    return builtin;
  }
  const custom = ev.current.resolveCall?.(operator, values);
  if (custom !== undefined) {
    return custom;
  }
  if (/^\p{Lu}/u.test(operator)) {
    if (values.length !== 1) {
      return fail(`variant constructor ${operator} requires one value, received ${values.length}`);
    }
    return variant(operator, values[0]!);
  }
  return fail(`unsupported runtime operator ${operator} for ${debugValues(values)}`);
}

function evaluateAssign(args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length !== 2) {
    return fail("assign requires a variable and an expression");
  }
  const expected = evaluate(args[1], { ...ev, current: ev.before }, env);
  if (ev.sink !== undefined) {
    ev.sink.value = expected;
    return bool(true);
  }
  const observed = evaluate(args[0], { ...ev, current: ev.after }, env);
  if (structurallyEqual(expected, observed)) {
    return bool(true);
  }
  return fail(`assign state diverged at ${structuralDifference(expected, observed, "state") ?? "state"}`);
}

/**
 * Evaluates the built-in operators. It returns `undefined` when the operator
 * and argument shapes do not match; the caller then consults the evidence's
 * own calls.
 */
function commonCall(operator: string, values: readonly RuntimeValue[]): RuntimeValue | undefined {
  const [first, second, third] = values;
  switch (operator) {
    case "eq":
      return values.length === 2 ? bool(equal(first!, second!)) : undefined;
    case "neq":
      return values.length === 2 ? bool(!equal(first!, second!)) : undefined;
    case "not":
      return values.length === 1 && first!.kind === "bool" ? bool(!first!.value) : undefined;
    case "Present":
      return values.length === 1 ? present(first!) : undefined;
    case "variant":
      return values.length === 2 && first!.kind === "text" ? variant(first!.value, second!) : undefined;
    case "List":
      return list(values);
    case "Tup":
      return tuple(values);
    case "Set":
      return set(values);
    case "Map":
      return mapFromValues(values);
    case "Rec":
      return recordFromValues(values);
    case "replicaPoolKey":
      if (values.length === 2 && first!.kind === "text" && second!.kind === "record") {
        return record({ replica_id: first!, pool_key: second! });
      }
      return undefined;
    case "field":
      if (values.length === 2 && first!.kind === "record" && second!.kind === "text") {
        return first!.fields.get(second!.value) ?? fail(`runtime record has no field ${second!.value}`);
      }
      return undefined;
    case "get":
      if (values.length === 2) {
        if (first!.kind === "record" && second!.kind === "text") {
          return first!.fields.get(second!.value) ?? absent;
        }
        if (first!.kind === "map") {
          return mapGet(first!, second!) ?? fail(`map has no key ${debug(second!)}`);
        }
      }
      return undefined;
    case "contains":
      return values.length === 2 && first!.kind === "set" ? bool(setContains(first!, second!)) : undefined;
    case "length":
      return values.length === 1 && first!.kind === "list" ? int(first!.items.length) : undefined;
    case "size":
      if (values.length === 1) {
        switch (first!.kind) {
          case "list":
          case "tuple":
            return int(first!.items.length);
          case "set":
            return int(first!.members.length);
          case "map":
            return int(first!.entries.length);
          case "record":
            return int(first!.fields.size);
          default:
            return undefined;
        }
      }
      return undefined;
    case "with":
      if (values.length === 3 && first!.kind === "record" && second!.kind === "text") {
        return recordWith(first!, second!.value, third!);
      }
      return undefined;
    case "set":
      if (values.length === 3) {
        if (first!.kind === "record" && second!.kind === "text") {
          return recordWith(first!, second!.value, third!);
        }
        if (first!.kind === "map") {
          if (mapGet(first!, second!) === undefined) {
            return fail(`set cannot add missing map key ${debug(second!)}`);
          }
          return mapWith(first!, second!, third!);
        }
      }
      return undefined;
    case "put":
      return values.length === 3 && first!.kind === "map" ? mapWith(first!, second!, third!) : undefined;
    case "union":
      return values.length === 2 && first!.kind === "set" && second!.kind === "set"
        ? set([...first!.members, ...second!.members])
        : undefined;
    case "exclude":
      if (values.length === 2 && first!.kind === "set" && second!.kind === "set") {
        const removed = second!;
        return { kind: "set", members: first!.members.filter(member => !setContains(removed, member)) };
      }
      return undefined;
    case "ilt":
    case "igt":
    case "ilte":
    case "igte":
    case "iadd":
    case "isub":
      if (values.length === 2 && first!.kind === "int" && second!.kind === "int") {
        const left = first!.value;
        const right = second!.value;
        switch (operator) {
          case "ilt":
            return bool(left < right);
          case "igt":
            return bool(left > right);
          case "ilte":
            return bool(left <= right);
          case "igte":
            return bool(left >= right);
          case "iadd":
            return int(left + right);
          default:
            return int(left - right);
        }
      }
      return undefined;
    case "append":
      return values.length === 2 && first!.kind === "list" ? list([...first!.items, second!]) : undefined;
    case "concat":
      return values.length === 2 && first!.kind === "list" && second!.kind === "list"
        ? list([...first!.items, ...second!.items])
        : undefined;
    case "indices":
      return values.length === 1 && first!.kind === "list"
        ? { kind: "set", members: first!.items.map((_, index) => int(index)) }
        : undefined;
    case "nth":
      if (values.length === 2 && first!.kind === "list" && second!.kind === "int") {
        const index = second!.value;
        if (index < 0n || index >= BigInt(first!.items.length)) {
          return fail(`list index ${index} is out of bounds`);
        }
        return first!.items[Number(index)]!;
      }
      return undefined;
    case "keys":
      return values.length === 1 && first!.kind === "map"
        ? { kind: "set", members: first!.entries.map(entry => entry[0]) }
        : undefined;
    default:
      return undefined;
  }
}

function recordFromValues(values: readonly RuntimeValue[]): RuntimeValue {
  if (values.length % 2 !== 0) {
    return fail("Rec requires key and value pairs");
  }
  const fields: [string, RuntimeValue][] = [];
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]!;
    if (key.kind !== "text") {
      return fail("Rec key is not text");
    }
    fields.push([key.value, values[index + 1]!]);
  }
  // A repeated key keeps the last value, as inserting into a map does.
  return record(new Map(fields));
}

function mapFromValues(values: readonly RuntimeValue[]): RuntimeValue {
  return map(
    values.map(value => {
      if (value.kind !== "tuple") {
        return fail("Map accepts only key/value tuples");
      }
      if (value.items.length !== 2) {
        return fail("Map entries must contain exactly two values");
      }
      return [value.items[0]!, value.items[1]!] as const;
    }),
  );
}

export function structurallyEqual(expected: RuntimeValue, observed: RuntimeValue): boolean {
  return structuralDifference(expected, observed, "state") === undefined;
}

/**
 * Names the first place two values diverge, or returns `undefined` when they
 * are equal. Messages match the Rust and Go bindings'.
 */
export function structuralDifference(expected: RuntimeValue, observed: RuntimeValue, path: string): string | undefined {
  switch (expected.kind) {
    case "record":
      if (observed.kind === "record") {
        if (expected.fields.size !== observed.fields.size) {
          const missing = [...expected.fields.keys()].filter(key => !observed.fields.has(key));
          const unexpected = [...observed.fields.keys()].filter(key => !expected.fields.has(key));
          return `${path} record fields differ; missing ${debugStrings(missing)}, unexpected ${debugStrings(unexpected)}`;
        }
        for (const [key, value] of expected.fields) {
          const nested = `${path}.${key}`;
          const observedValue = observed.fields.get(key);
          if (observedValue === undefined) {
            return `${nested} missing from observed state`;
          }
          const difference = structuralDifference(value, observedValue, nested);
          if (difference !== undefined) {
            return difference;
          }
        }
        return undefined;
      }
      break;
    case "present":
      if (observed.kind === "present") {
        return structuralDifference(expected.value, observed.value, path);
      }
      break;
    case "list":
      if (observed.kind === "list") {
        if (expected.items.length !== observed.items.length) {
          return `${path} expected list length ${expected.items.length}, observed ${observed.items.length}`;
        }
        for (let index = 0; index < expected.items.length; index += 1) {
          const difference = structuralDifference(expected.items[index]!, observed.items[index]!, `${path}[${index}]`);
          if (difference !== undefined) {
            return difference;
          }
        }
        return undefined;
      }
      break;
    case "map":
      if (observed.kind === "map") {
        const keyPath = (key: RuntimeValue): string => {
          switch (key.kind) {
            case "text":
              return `${path}[${debugString(key.value)}]`;
            case "int":
              return `${path}[${key.value}]`;
            default:
              return `${path}[${debug(key)}]`;
          }
        };
        for (const [key] of expected.entries) {
          if (mapGet(observed, key) === undefined) {
            return `${keyPath(key)} missing from observed state`;
          }
        }
        for (const [key] of observed.entries) {
          if (mapGet(expected, key) === undefined) {
            return `${keyPath(key)} unexpected in observed state`;
          }
        }
        for (const [key, value] of expected.entries) {
          const difference = structuralDifference(value, mapGet(observed, key)!, keyPath(key));
          if (difference !== undefined) {
            return difference;
          }
        }
        return undefined;
      }
      break;
    default:
      break;
  }
  if (equal(expected, observed)) {
    return undefined;
  }
  return `${path} expected ${debug(expected)}, observed ${debug(observed)}`;
}

// Quint's `and` and `or` stop at the first argument that decides the result,
// so a later argument may rely on an earlier one, as in
// `l.length() > i and l[i] == x`.
function evaluateShortCircuit(operator: string, args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  const decisive = operator === "or" || operator === "actionAny";
  for (const argument of args) {
    const value = evaluate(argument, ev, env);
    if (value.kind !== "bool") {
      return fail(`${operator} accepts only normalized booleans`);
    }
    if (value.value === decisive) {
      return bool(decisive);
    }
  }
  return bool(!decisive);
}

function evaluateIte(args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length !== 3) {
    return fail("ite requires a condition and two branches");
  }
  const condition = evaluate(args[0], ev, env);
  if (condition.kind !== "bool") {
    return fail("ite condition is not boolean");
  }
  return evaluate(condition.value ? args[1] : args[2], ev, env);
}

function isLambda(value: Json | undefined): boolean {
  return kindOf(value) === "lambda";
}

function firstParameter(lambda: Json | undefined): string | undefined {
  const parameters = jsonField(lambda, "parameters");
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return undefined;
  }
  const name = (parameters as readonly Json[])[0];
  return typeof name === "string" ? name : undefined;
}

function evaluateQuantifier(operator: string, args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length !== 2) {
    return fail(`${operator} requires a collection and one lambda`);
  }
  const collection = evaluate(args[0], ev, env);
  let items: readonly RuntimeValue[];
  switch (collection.kind) {
    case "set":
      items = collection.members;
      break;
    case "list":
    case "tuple":
      items = collection.items;
      break;
    case "map":
      items = collection.entries.map(entry => entry[1]);
      break;
    case "record":
      items = [...collection.fields.values()];
      break;
    default:
      return fail(`${operator} input is not a collection`);
  }
  const lambda = args[1];
  if (!isLambda(lambda)) {
    return fail(`${operator} predicate is not a lambda`);
  }
  const parameter = firstParameter(lambda);
  if (parameter === undefined) {
    return fail(`${operator} lambda has no parameter`);
  }
  const body = jsonField(lambda, "body");
  let all = true;
  let any = false;
  for (const item of items) {
    const value = evaluate(body, ev, extend(env, parameter, item));
    if (value.kind !== "bool") {
      return fail(`${operator} predicate did not evaluate to boolean`);
    }
    all = all && value.value;
    any = any || value.value;
  }
  return bool(operator === "forall" ? all : any);
}

function evaluateFilter(args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length !== 2) {
    return fail("filter requires a list and one lambda");
  }
  const collection = evaluate(args[0], ev, env);
  if (collection.kind !== "list" && collection.kind !== "set") {
    return fail("filter input is not a list or set");
  }
  const items = collection.kind === "list" ? collection.items : collection.members;
  const filtered: RuntimeValue[] = [];
  for (const item of items) {
    const value = evaluateLambda(args[1], [item], ev, env);
    if (value.kind !== "bool") {
      return fail("filter predicate did not evaluate to boolean");
    }
    if (value.value) {
      filtered.push(item);
    }
  }
  return collection.kind === "set" ? { kind: "set", members: filtered } : list(filtered);
}

function evaluateMap(operator: string, args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length !== 2) {
    return fail(`${operator} requires a set and one lambda`);
  }
  const collection = evaluate(args[0], ev, env);
  if (collection.kind !== "set") {
    return fail(`${operator} input is not a set`);
  }
  if (operator === "map") {
    return set(collection.members.map(member => evaluateLambda(args[1], [member], ev, env)));
  }
  return map(collection.members.map(key => [key, evaluateLambda(args[1], [key], ev, env)] as const));
}

function evaluateFold(args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length !== 3) {
    return fail("fold requires a set, initial value, and lambda");
  }
  const collection = evaluate(args[0], ev, env);
  if (collection.kind !== "set") {
    return fail("fold input is not a set");
  }
  let accumulator = evaluate(args[1], ev, env);
  for (const member of collection.members) {
    accumulator = evaluateLambda(args[2], [accumulator, member], ev, env);
  }
  return accumulator;
}

function evaluateLambda(lambda: Json | undefined, args: readonly RuntimeValue[], ev: Eval, env: Environment): RuntimeValue {
  if (!isLambda(lambda)) {
    return fail("expected a normalized lambda");
  }
  const parameters = jsonField(lambda, "parameters");
  if (!Array.isArray(parameters)) {
    return fail("normalized lambda has no parameters");
  }
  if (parameters.length !== args.length) {
    return fail(`lambda expects ${parameters.length} arguments, received ${args.length}`);
  }
  let nested = env;
  (parameters as readonly Json[]).forEach((parameter, index) => {
    if (typeof parameter !== "string") {
      return fail("normalized lambda parameter is not a name");
    }
    nested = extend(nested, parameter, args[index]!);
    return undefined;
  });
  return evaluate(jsonField(lambda, "body"), ev, nested);
}

function evaluateMatchVariant(args: readonly Json[], ev: Eval, env: Environment): RuntimeValue {
  if (args.length === 0) {
    return fail("matchVariant has no value");
  }
  const value = evaluate(args[0], ev, env);
  let tag: string;
  let payload: RuntimeValue | undefined;
  switch (value.kind) {
    case "absent":
      tag = "Absent";
      break;
    case "present":
      tag = "Present";
      payload = value.value;
      break;
    case "variant":
      tag = value.tag;
      payload = value.value;
      break;
    case "text":
      tag = value.value;
      payload = tuple();
      break;
    default:
      return fail("matchVariant value is not a normalized variant");
  }
  const branches = args.slice(1);
  for (let index = 0; index + 1 < branches.length; index += 2) {
    const branchTag = evaluate(branches[index], ev, env);
    if (branchTag.kind !== "text") {
      return fail("matchVariant tag is not text");
    }
    // `_` is Quint's default branch: it matches whatever no earlier branch did.
    if (branchTag.value !== tag && branchTag.value !== "_") {
      continue;
    }
    const lambda = branches[index + 1];
    if (!isLambda(lambda)) {
      return fail("matchVariant branch is not a lambda");
    }
    const parameter = firstParameter(lambda);
    if (parameter === undefined) {
      return fail("matchVariant lambda has no parameter");
    }
    const branchEnvironment = payload === undefined ? env : extend(env, parameter, payload);
    return evaluate(jsonField(lambda, "body"), ev, branchEnvironment);
  }
  return fail("matchVariant has no matching branch");
}
