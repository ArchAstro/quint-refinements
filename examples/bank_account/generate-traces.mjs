import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateConformanceTraces } from "@archastro/quint-refinements/harness/generate.mjs";
import { bankApp } from "./app-config.mjs";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(projectDir, "traces.json");
const check = process.argv.slice(2).includes("--check");
const unexpectedArguments = process.argv.slice(2).filter(argument => argument !== "--check");

if (unexpectedArguments.length > 0) {
  throw new Error(`unsupported arguments: ${unexpectedArguments.join(" ")}`);
}

const traces = generateConformanceTraces({
  root: projectDir,
  specDir: projectDir,
  app: bankApp,
  fullyRefinedRuns: new Set(["bank.withdrawRun"]),
});
const generated = `${JSON.stringify(traces, null, 2)}\n`;

if (check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== generated) {
    throw new Error("bank traces drifted; run npm run generate");
  }
  console.log("bank traces match the Quint model");
} else {
  fs.writeFileSync(outputPath, generated);
  console.log("wrote traces.json");
}
