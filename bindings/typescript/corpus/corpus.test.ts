// Executes the shared binding corpus in conformance/cases through the
// TypeScript runtime. Every binding runs the same artifacts and must report the
// same primitive calls, obligation count, and final state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  collectOwnershipRecords,
  FixtureTable,
  fromItfJson,
  parseConformanceArtifact,
  refineScenario,
  scenarioId,
  type Evidence,
  type OwnershipTable,
  type PrimitiveDriver,
  type ResolvedAction,
  type RuntimeValue,
} from "quint-refinements/runtime";

import { BankAdapter } from "../../../examples/typescript/bank_account/bank.ts";
import * as bankAdapter from "../../../examples/typescript/bank_account/generated_refinement.ts";
import { Coordinator, fixtureTable } from "../../../examples/typescript/two_phase_commit/coordinator.ts";
import * as coordinatorAdapter from "../../../examples/typescript/two_phase_commit/generated_refinement.ts";

interface Expected {
  scenario: string;
  primitiveCalls: { primitive: string; actions: string[]; arguments: unknown[] }[];
  evaluatedObligations: number;
  finalState: Record<string, unknown>;
}

function caseFile(name: string, file: string): string {
  return readFileSync(new URL(`../../../conformance/cases/${name}/${file}`, import.meta.url), "utf8");
}

/** The corpus's arguments are scalars; a bigint becomes a JSON number. */
function scalar(value: RuntimeValue): unknown {
  switch (value.kind) {
    case "bool":
    case "text":
      return value.value;
    case "int":
      return Number(value.value);
    default:
      return assert.fail(`corpus arguments are scalars; got ${value.kind}`);
  }
}

/** Notes each primitive call on its way to the generated dispatcher. */
function recording(inner: PrimitiveDriver, calls: Expected["primitiveCalls"]): PrimitiveDriver {
  return {
    runPrimitive(primitive: string, actions: readonly ResolvedAction[]): readonly Evidence[] {
      calls.push({
        primitive,
        actions: actions.map(action => action.name),
        arguments: actions.flatMap(action => action.arguments.map(scalar)),
      });
      return inner.runPrimitive(primitive, actions) as readonly Evidence[];
    },
  };
}

function runCase<I extends { snapshot(): Evidence }>(
  name: string,
  ownership: OwnershipTable,
  retrieve: readonly string[],
  newImplementation: (initial: RuntimeValue) => I,
  driverFor: (implementation: I) => PrimitiveDriver,
  fixtures: (artifact: ReturnType<typeof parseConformanceArtifact>) => FixtureTable,
) {
  // Setup: the corpus artifact and expectation, exactly as other bindings read them.
  const artifact = parseConformanceArtifact(caseFile(name, "artifact.json"));
  const expected = JSON.parse(caseFile(name, "expected.json")) as Expected;
  const scenario = artifact.scenarios.find(candidate => scenarioId(candidate) === expected.scenario);
  assert.ok(scenario?.initialState !== undefined, "the expected scenario is in the artifact");
  const table = fixtures(artifact);
  table.validate(artifact);

  // Action: refine the scenario against the real implementation.
  const implementation = newImplementation(fromItfJson(scenario.initialState));
  const calls: Expected["primitiveCalls"] = [];
  const evaluated = refineScenario(
    scenario,
    implementation.snapshot(),
    collectOwnershipRecords(ownership),
    retrieve,
    table,
    recording(driverFor(implementation), calls),
  );
  return { expected, calls, evaluated, implementation };
}

test("the bank_withdraw case matches the shared expectation", () => {
  const { expected, calls, evaluated, implementation } = runCase(
    "bank_withdraw",
    bankAdapter.ownership,
    bankAdapter.retrieve,
    BankAdapter.fromState,
    bankAdapter.driver,
    artifact => FixtureTable.fromArtifact("bank", artifact),
  );

  // Outcome: calls, obligations, and final state all match the shared case.
  assert.deepEqual(calls, expected.primitiveCalls);
  assert.equal(evaluated, expected.evaluatedObligations);
  assert.deepEqual({ balance: implementation.bank.balance }, expected.finalState);
});

test("the two_phase_commit case matches the shared expectation", () => {
  const { expected, calls, evaluated, implementation } = runCase(
    "two_phase_commit",
    coordinatorAdapter.ownership,
    coordinatorAdapter.retrieve,
    Coordinator.fromState,
    coordinatorAdapter.driver,
    () => fixtureTable(),
  );

  assert.deepEqual(calls, expected.primitiveCalls);
  assert.equal(evaluated, expected.evaluatedObligations);
  assert.deepEqual(implementation.state(), expected.finalState);
});
