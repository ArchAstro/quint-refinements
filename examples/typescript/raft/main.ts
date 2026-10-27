// Checks a TypeScript Raft cluster against the Quint model in
// examples/rust/raft/model.qnt.
//
// Regenerate the adapter and its artifact with `npm run generate` at the
// repository root.
import { RaftAdapter } from "./raft.ts";
import { refineAllSync } from "./generated_refinement.ts";

try {
  for (const result of refineAllSync(RaftAdapter.fromState)) {
    console.log(`${result.scenario} refined ${result.evaluatedObligations} obligations`);
  }
} catch (error) {
  console.error(`refinement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
