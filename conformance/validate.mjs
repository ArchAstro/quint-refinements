import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(fs.readFileSync(new URL("./artifact.schema.json", import.meta.url)));
const validate = new Ajv2020({ allErrors: true }).compile(schema);
const artifacts = [
  "./cases/bank_withdraw/artifact.json",
  "./cases/bank_withdraw_v2/artifact.json",
  "./cases/two_phase_commit/artifact.json",
];

for (const relativePath of artifacts) {
  const artifact = JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url)));
  if (!validate(artifact)) {
    throw new Error(`${relativePath} violates artifact.schema.json:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
  // Every reference must name a list in the table (JSON Schema cannot say so).
  for (const step of artifact.scenarios.flatMap(scenario => scenario.steps)) {
    for (const field of ["guardList", "nextList"]) {
      if (step[field] !== undefined && step[field] >= artifact.assertionLists.length) {
        throw new Error(`${relativePath}: ${field} ${step[field]} is out of range`);
      }
    }
  }
}

console.log(`${artifacts.length} binding conformance artifacts match schema v2 or v3`);
