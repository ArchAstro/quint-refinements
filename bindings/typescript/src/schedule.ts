import { actionSteps, type ArtifactScenario } from "./artifact.js";
import { fail } from "./error.js";
import type { Evidence } from "./evidence.js";
import type { OwnershipDescriptor } from "./ownership.js";

/** One impl command the driver must run, and the Quint actions it fills. */
export interface ScheduledPrimitiveRun {
  /** The stable identifier of the implementation command to execute. */
  readonly primitive: string;
  /** The ordered model actions covered by this single execution. */
  readonly ownedActions: readonly string[];
}

/** Action names from the generated scenario, in JSON order. */
export function scenarioActionNames(scenario: ArtifactScenario): string[] {
  return actionSteps(scenario).map(step => step.action);
}

type Fit = "compound" | "partialCompound" | "singleton";

function startsWith(remaining: readonly string[], prefix: readonly string[]): boolean {
  return remaining.length >= prefix.length && prefix.every((name, index) => remaining[index] === name);
}

function fitRecord(record: OwnershipDescriptor, remaining: readonly string[]): Fit | undefined {
  const first = remaining[0];
  if (first === undefined) {
    return undefined;
  }
  if (record.refines.length > 0) {
    if (startsWith(remaining, record.refines)) {
      return record.refines.length > 1 ? "compound" : "singleton";
    }
    if (record.refines.length > 1 && remaining[0] === record.refines[0] && remaining.length > 1 && remaining[1] === record.refines[1]) {
      return "partialCompound";
    }
    if (record.aliases.includes(first)) {
      return "singleton";
    }
    return undefined;
  }
  return record.actions.includes(first) ? "singleton" : undefined;
}

function uniqueRecord(records: readonly OwnershipDescriptor[], action: string): OwnershipDescriptor | undefined {
  if (records.length <= 1) {
    return records[0];
  }
  return fail(`JSON action ${action} is owned by multiple primitives (${records.map(record => record.primitive).join(", ")})`);
}

/**
 * Walks generated actions against ownership records.
 *
 * `refines` is the ordered spec tape of one impl command. JSON must present
 * that sequence intact. Aliases are extra names for a 1-step refine. Legacy
 * `actions` lists (no `refines`) stay independent 1-step runs.
 */
export function schedulePrimitiveRuns(
  jsonActions: readonly string[],
  ownership: readonly OwnershipDescriptor[],
): ScheduledPrimitiveRun[] {
  const runs: ScheduledPrimitiveRun[] = [];
  let index = 0;
  while (index < jsonActions.length) {
    const remaining = jsonActions.slice(index);
    const first = remaining[0]!;
    const compounds: OwnershipDescriptor[] = [];
    const partials: OwnershipDescriptor[] = [];
    const singletons: OwnershipDescriptor[] = [];
    for (const record of ownership) {
      const fit = fitRecord(record, remaining);
      if (fit === "compound") {
        compounds.push(record);
      } else if (fit === "partialCompound") {
        partials.push(record);
      } else if (fit === "singleton") {
        singletons.push(record);
      }
    }
    const compound = uniqueRecord(compounds, first);
    if (compound !== undefined) {
      runs.push({ primitive: compound.primitive, ownedActions: [...compound.refines] });
      index += compound.refines.length;
      continue;
    }
    const partial = partials[0];
    if (partial !== undefined) {
      const count = Math.min(partial.refines.length, remaining.length);
      return fail(
        `primitive ${partial.primitive} JSON actions [${remaining.slice(0, count).join(", ")}] are not the owned sequence [${partial.refines.join(", ")}]`,
      );
    }
    const singleton = uniqueRecord(singletons, first);
    if (singleton === undefined) {
      return fail(`JSON action ${first} has no ownership record`);
    }
    runs.push({ primitive: singleton.primitive, ownedActions: [first] });
    index += 1;
  }
  return runs;
}

/** Checks that a primitive returned one evidence snapshot per owned action, then appends them. */
export function extendValidatedTape(
  snapshots: readonly Evidence[],
  run: ScheduledPrimitiveRun,
  tape: readonly Evidence[],
): Evidence[] {
  if (tape.length !== run.ownedActions.length) {
    return fail(
      `primitive ${run.primitive} owns ${run.ownedActions.length} actions but returned ${tape.length} evidence snapshots`,
    );
  }
  return [...snapshots, ...tape];
}

/**
 * Builds init plus one retrieve-after snapshot per JSON action. `runPrimitive`
 * runs the impl command for one scheduled tape and must return exactly
 * `ownedActions.length` evidences in that order.
 */
export function collectOwnedActionSnapshots(
  scenario: ArtifactScenario,
  init: Evidence,
  ownership: readonly OwnershipDescriptor[],
  runPrimitive: (primitive: string, ownedActions: readonly string[]) => readonly Evidence[],
): Evidence[] {
  let snapshots: Evidence[] = [init];
  for (const run of schedulePrimitiveRuns(scenarioActionNames(scenario), ownership)) {
    snapshots = extendValidatedTape(snapshots, run, runPrimitive(run.primitive, run.ownedActions));
  }
  return snapshots;
}
