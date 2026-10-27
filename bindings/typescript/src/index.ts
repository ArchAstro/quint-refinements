/**
 * Check a TypeScript implementation against a Quint model.
 *
 * This is the runtime that `quint-refinements compile --typescript` generated
 * adapters build on. It reads the same schema-v2 artifact as the Rust and Go
 * runtimes and reports the same obligation counts and divergence messages.
 *
 * @module
 */

export { RefinementError } from "./error.js";
export {
  absent,
  bool,
  compare,
  debug,
  equal,
  fromItfJson,
  fromItfText,
  int,
  list,
  map,
  mapGet,
  mapWith,
  present,
  record,
  recordKeys,
  recordWith,
  set,
  setContains,
  text,
  textSet,
  tuple,
  variant,
} from "./value.js";
export type {
  AbsentValue,
  BoolValue,
  IntValue,
  ListValue,
  MapEntry,
  MapValue,
  PresentValue,
  RecordValue,
  RuntimeValue,
  RuntimeValueKind,
  SetValue,
  TextValue,
  TupleValue,
  VariantValue,
} from "./value.js";
export { asBool, asInt, asList, asRecord, asText, fieldOf } from "./access.js";
export { parseJson, jsonString } from "./json.js";
export type { Json, JsonObject } from "./json.js";
export { actionSteps, parseConformanceArtifact, scenarioId } from "./artifact.js";
export { expressionVocabulary } from "./vocabulary.js";
export type {
  ActionStep,
  ArtifactAssertion,
  ArtifactScenario,
  ArtifactStep,
  ArtifactVocabulary,
  AssertionScope,
  ConformanceArtifact,
  InitStep,
  ObserveStep,
} from "./artifact.js";
export { stateEvidence } from "./evidence.js";
export type { Evidence } from "./evidence.js";
export { collectOwnershipRecords } from "./ownership.js";
export type { OwnershipDescriptor, OwnershipRecord, OwnershipTable } from "./ownership.js";
export { collectOwnedActionSnapshots, scenarioActionNames, schedulePrimitiveRuns } from "./schedule.js";
export type { ScheduledPrimitiveRun } from "./schedule.js";
export { bindEvidence, expressionNames, FixtureTable, intFixture, textFixture } from "./fixtures.js";
export type { QuintFixture } from "./fixtures.js";
export {
  evaluateActionArguments,
  evaluateAllActionSteps,
  evaluateAllStepObligations,
  evaluateChapterNext,
  evaluateEveryActionStep,
  evaluatePrecedingActionNext,
  evaluateProjectedActionSteps,
  evaluateProjectedRuntimeAssertions,
  evaluateRuntimeAssertions,
  evaluateStepObligations,
} from "./evaluate.js";
export {
  evaluateRefinedRuntimeAssertions,
  evaluateRefinedTape,
  formatAction,
  formatActions,
  formatStrings,
  refineScenario,
  refineScenarioAsync,
  RefinementSession,
  resolveActionPlan,
  runRefinedActions,
  runRefinedActionsAsync,
} from "./drive.js";
export type {
  ActionDriver,
  AsyncActionDriver,
  AsyncPrimitiveDriver,
  PrimitiveDriver,
  RefinementRun,
  ResolvedAction,
} from "./drive.js";
export { ensureSynchronous } from "./async.js";
export type { MaybeAsync } from "./async.js";
