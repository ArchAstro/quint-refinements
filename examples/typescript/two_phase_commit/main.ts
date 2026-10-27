// Checks a TypeScript two-phase commit coordinator against model.qnt, with one
// commit() owning three Quint actions and the status universe bound to a
// production value.
//
// Regenerate the adapter with:
//   node ../../../packages/compiler/cli.mjs compile model.qnt --typescript generated_refinement.ts
import { Coordinator, fixtureTable } from "./coordinator.ts";
import { refineAll } from "./generated_refinement.ts";

try {
  for (const result of await refineAll(Coordinator.fromState, { fixtures: fixtureTable })) {
    console.log(`${result.scenario} refined ${result.evaluatedObligations} obligations`);
  }
} catch (error) {
  console.error(`two-phase commit refinement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
