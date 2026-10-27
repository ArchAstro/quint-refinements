// Checks a TypeScript bank against the Quint model in bank.qnt.
//
// Regenerate the adapter with:
//   node ../../../packages/compiler/cli.mjs compile bank.qnt --typescript generated_refinement.ts
import { BankAdapter } from "./bank.ts";
import { refineAllSync } from "./generated_refinement.ts";

try {
  for (const result of refineAllSync(BankAdapter.fromState)) {
    console.log(`${result.scenario} refined ${result.evaluatedObligations} obligations; final balance ${result.implementation.bank.balance}`);
  }
} catch (error) {
  console.error(`bank refinement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
