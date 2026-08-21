import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateConformanceTraces } from "../../harness/generate.mjs";
import { twoPhaseCommitApp } from "./app-config.mjs";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(specDir, "../../../../..");
const outputPath = path.join(specDir, "traces.json");
const check = process.argv.slice(2).includes("--check");
const unexpectedArguments = process.argv.slice(2).filter(argument => argument !== "--check");
if (unexpectedArguments.length > 0) {
  throw new Error(`unsupported arguments: ${unexpectedArguments.join(" ")}`);
}

const traces = generateConformanceTraces({
  root,
  specDir,
  app: twoPhaseCommitApp,
  fullyRefinedRuns: new Set(["two_phase_commit.commitRun"]),
});
const generated = `${JSON.stringify(traces, null, 2)}\n`;
if (check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== generated) {
    throw new Error("2PC traces drifted; run generate-traces.mjs");
  }
  console.log("2PC committed traces match the Quint model");
} else {
  fs.writeFileSync(outputPath, generated);
  console.log(`Wrote ${path.relative(root, outputPath)}`);
}
