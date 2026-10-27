import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseConformanceArtifact, scenarioId } from "../dist/index.js";
import { minimalArtifact } from "./helpers.ts";

test("parses the shared corpus artifacts", () => {
  for (const name of ["bank_withdraw", "two_phase_commit"]) {
    const artifact = parseConformanceArtifact(readFileSync(new URL(`../../../conformance/cases/${name}/artifact.json`, import.meta.url), "utf8"));
    assert.equal(artifact.schemaVersion, 2);
    assert.ok(artifact.scenarios.length > 0, name);
    for (const scenario of artifact.scenarios) {
      assert.notEqual(scenario.initialState, undefined, `${name}: ${scenarioId(scenario)} has no initial state`);
    }
  }
});

test("parses every field of a minimal artifact", () => {
  const artifact = parseConformanceArtifact(minimalArtifact);
  assert.equal(artifact.modelDigest, "sha256:test");
  assert.deepEqual(artifact.vocabulary.capabilities, ["transport.basic"]);
  assert.deepEqual(Object.keys(artifact.fixtures), ["m"]);
  assert.deepEqual(Object.keys(artifact.fixtures["m"]!), []);
  const [scenario] = artifact.scenarios;
  assert.equal(scenarioId(scenario!), "m.run");
  assert.deepEqual(scenario?.steps.map(step => step.kind), ["init", "action", "action", "action"]);
  assert.equal(scenario?.initialState, undefined);
});

test("parse rejects malformed artifacts", () => {
  const cases: [name: string, from: string, to: string, want: string][] = [
    ["unknown top-level field", '"schemaVersion": 2,', '"schemaVersion": 2, "extra": 1,', "unknown field `extra`"],
    ["missing field", '"modelDigest": "sha256:test",', "", "missing field `modelDigest`"],
    ["unknown step field", '"kind": "init", "action": "init"', '"kind": "init", "action": "init", "guards": []', "unknown field `guards`"],
    ["unknown step kind", '"kind": "init"', '"kind": "teleport"', "unknown variant `teleport`"],
    ["wrong type", '"schemaVersion": 2', '"schemaVersion": "two"', "invalid field `schemaVersion`"],
    ["negative count", '"index": 1,', '"index": -1,', "invalid field `index`"],
    ["unknown scope", '"arguments": []},\n      {"index": 2', '"arguments": [], "guards": [{"scope": "x", "expression": {}}]},\n      {"index": 2', "unknown variant `x`"],
    ["non-string capability", '"capabilities": ["transport.basic"]', '"capabilities": [1]', "invalid field `capabilities`"],
  ];
  for (const [name, from, to, want] of cases) {
    const text = minimalArtifact.replace(from, to);
    assert.notEqual(text, minimalArtifact, `${name}: the test edit did not apply`);
    assert.throws(
      () => parseConformanceArtifact(text),
      (error: Error) => error.message.startsWith("invalid refinement artifact: ") && error.message.includes(want),
      name,
    );
  }
  assert.throws(() => parseConformanceArtifact("[]"), /invalid refinement artifact: artifact must be an object/);
  assert.throws(() => parseConformanceArtifact("{"), /invalid refinement artifact:/);
});

test("a complete refinement artifact must use the evaluator's vocabulary", () => {
  const text = minimalArtifact.replace('"steps": [', '"initialState": {}, "steps": [');
  assert.throws(() => parseConformanceArtifact(text), {
    message: "artifact refinement expression vocabulary differs from the TypeScript evaluator",
  });
});

test("schemaVersion is a u32", () => {
  assert.throws(() => parseConformanceArtifact(minimalArtifact.replace('"schemaVersion": 2', '"schemaVersion": 4294967296')), /invalid field `schemaVersion`/);
});
