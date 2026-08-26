import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(fs.readFileSync(new URL("./artifact.schema.json", import.meta.url)));
const validate = new Ajv2020({ allErrors: true }).compile(schema);
const artifacts = [
  "./cases/bank_withdraw/artifact.json",
  "./cases/two_phase_commit/artifact.json",
];

for (const relativePath of artifacts) {
  const artifact = JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url)));
  if (!validate(artifact)) {
    throw new Error(`${relativePath} violates artifact.schema.json:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
}

console.log(`${artifacts.length} binding conformance artifacts match schema v2`);
