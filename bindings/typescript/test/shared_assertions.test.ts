import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { type ActionStep, parseConformanceArtifact } from "../dist/index.js";

const eqOne = '{"scope":"runtime","expression":{"kind":"call","operator":"eq","arguments":[{"kind":"name","value":"state"},{"kind":"int","value":1}]}}';

function artifact(version: number, extra: string, fields: string): string {
  return `{
  "schemaVersion": ${version},
  "modelDigest": "sha256:shared-assertions-test",
  "vocabulary": {
    "actions": ["step"], "capabilities": [], "expressionOperators": [], "expressionNames": [],
    "runtimeObservationDependencies": [], "runtimeObservationDependencyDigest": "sha256:test"
  },
  "fixtures": {},
  ${extra}
  "scenarios": [{
    "source": "s.qnt", "module": "s", "fixtureNamespace": "s", "name": "run",
    "requiredCapabilities": [],
    "steps": [{"index": 1, "kind": "action", "action": "step", "arguments": [] ${fields}}]
  }]
}`;
}

function firstAction(source: string): ActionStep {
  return parseConformanceArtifact(source).scenarios[0]!.steps[0] as ActionStep;
}

test("v3 steps resolve their shared lists", () => {
  const lists = `"assertionLists": [[${eqOne}], [${eqOne}, ${eqOne}]],`;
  const step = firstAction(artifact(3, lists, ', "guardList": 0, "nextList": 1'));
  assert.equal(step.guards.length, 1);
  assert.equal(step.next.length, 2);
  assert.equal(step.guards[0]?.scope, "runtime");
});

test("v2 inline lists still load", () => {
  const source = artifact(2, "", `, "guards": [${eqOne}], "next": [${eqOne}]`);
  assert.equal(parseConformanceArtifact(source).schemaVersion, 2);
  const step = firstAction(source);
  assert.equal(step.guards.length, 1);
  assert.equal(step.next.length, 1);
});

test("the v2 and v3 corpus artifacts resolve to the same scenarios", () => {
  const read = (name: string) =>
    parseConformanceArtifact(readFileSync(new URL(`../../../conformance/cases/${name}/artifact.json`, import.meta.url), "utf8"));
  const v2 = read("bank_withdraw_v2");
  const v3 = read("bank_withdraw");
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v3.schemaVersion, 3);
  assert.deepEqual(v2.scenarios, v3.scenarios);
});

test("bad shared lists are rejected", () => {
  const lists = `"assertionLists": [[${eqOne}]],`;
  const cases: [name: string, source: string, want: string][] = [
    ["guard reference out of range", artifact(3, lists, ', "guardList": 1'), "`guardList` 1 is out of range: the artifact has 1 assertion lists"],
    ["next reference without a table", artifact(3, "", ', "nextList": 0'), "`nextList` 0 is out of range"],
    ["negative reference", artifact(3, lists, ', "nextList": -1'), "`nextList` -1 is out of range"],
    ["non-integer reference", artifact(3, lists, ', "nextList": "0"'), "`nextList` 0 is out of range"],
    ["inline in v3", artifact(3, lists, `, "guards": [${eqOne}]`), "inline"],
    ["list in v2", artifact(2, "", ', "guardList": 0'), "schema version 3"],
    ["table in v2", artifact(2, lists, ""), "assertionLists"],
    ["unknown version", artifact(4, "", ""), "unsupported schema version 4"],
  ];
  for (const [name, source, want] of cases) {
    assert.throws(() => parseConformanceArtifact(source), error => error instanceof Error && error.message.includes(want), name);
  }
});
