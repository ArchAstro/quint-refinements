import assert from "node:assert/strict";
import test from "node:test";

import {
  equal,
  expressionNames,
  FixtureTable,
  int,
  intFixture,
  parseConformanceArtifact,
  set,
  text,
  textFixture,
  type QuintFixture,
} from "../dist/index.js";
import { call, lambda, minimalArtifact, nameExpr } from "./helpers.ts";

const artifactWithFixtures = (fixtures: string) =>
  parseConformanceArtifact(minimalArtifact.replace('"fixtures": { "m": {} }', `"fixtures": { "m": ${fixtures} }`));

const status = (tag: string): QuintFixture => ({
  artifactJson: () => ({ tag, value: { "#tup": [] } }),
  runtimeValue: () => text(tag),
});

test("a table taken from the artifact has the model's values", () => {
  const artifact = artifactWithFixtures('{"limit": 3, "roles": {"#set": [{"tag": "A", "value": {"#tup": []}}]}}');
  const table = FixtureTable.fromArtifact("m", artifact);
  assert.deepEqual(table.get("limit"), int(3));
  assert.ok(equal(table.get("roles")!, set([text("A")])));
  table.validate(artifact);
  assert.deepEqual(table.retrieveNames(), ["name:limit", "name:roles"]);
  assert.equal(FixtureTable.fromArtifact("absent", artifact).names().length, 0);
});

test("owned fixtures are checked against the model", () => {
  const artifact = artifactWithFixtures(
    '{"limit": 3, "roles": {"#set": [{"tag": "A", "value": {"#tup": []}}, {"tag": "B", "value": {"#tup": []}}]}}',
  );
  new FixtureTable("m").insert("limit", intFixture(3)).insertSet("roles", status("B"), status("A")).validate(artifact);

  assert.throws(() => new FixtureTable("m").insert("limit", intFixture(4)).insertSet("roles", status("A"), status("B")).validate(artifact), {
    message: "fixture limit JSON diverged: artifact 3 rust 4",
  });
  const missing = new FixtureTable("m").insert("limit", intFixture(3));
  assert.throws(() => missing.validate(artifact), {
    message: 'fixture namespace m names differ: artifact ["limit", "roles"] rust ["limit"]',
  });
  missing.validateEntries(artifact); // entry validation tolerates extra artifact fixtures
  assert.throws(() => new FixtureTable("other").validate(artifact), { message: "fixture namespace other is missing from the artifact" });
  assert.throws(() => new FixtureTable("m").insert("ghost", intFixture(1)).validateEntries(artifact), {
    message: "artifact namespace m is missing fixture ghost",
  });
});

test("fixture JSON may be written with numbers, bigints or nested plain objects", () => {
  const artifact = artifactWithFixtures('{"big": 9007199254740993, "org": {"id": "o1", "tags": ["x"]}}');
  const fixture = (json: unknown): QuintFixture => ({ artifactJson: () => json, runtimeValue: () => int(0) });
  new FixtureTable("m").insert("big", intFixture(9007199254740993n)).insert("org", fixture({ id: "o1", tags: ["x"] })).validate(artifact);
  assert.throws(() => new FixtureTable("m").insert("big", textFixture("9007199254740993")).validateEntries(artifact), /fixture big JSON diverged/);
});

test("record fixtures differ in key-subset versus exact mode", () => {
  const artifact = artifactWithFixtures('{"org": {"id": "o1", "name": "Acme"}}');
  const record = (json: unknown): QuintFixture => ({ artifactJson: () => json, runtimeValue: () => text("") });
  const partial = new FixtureTable("m").insert("org", record({ id: "o1" }));
  partial.validateEntries(artifact); // a key subset matches in entry mode
  assert.throws(() => partial.validate(artifact), "a key subset is not enough for full validation");
  assert.throws(() => new FixtureTable("m").insert("org", record({ organization_id: "o1" })).validateEntries(artifact));
});

test("scenario names must have an owner", () => {
  const text = minimalArtifact.replace(
    '{"index": 1, "kind": "action", "action": "submitInvocation", "arguments": []}',
    `{"index": 1, "kind": "action", "action": "submitInvocation", "arguments": [],
      "guards": [{"scope": "runtime", "expression": {"kind": "call", "operator": "contains", "arguments": [{"kind": "name", "value": "universe"}, {"kind": "name", "value": "state"}]}}]}`,
  );
  const artifact = parseConformanceArtifact(text);
  const table = new FixtureTable("m");
  assert.throws(() => table.validate(artifact), {
    message: "m.run:submitInvocation names universe but neither fixtures nor snapshot state own it",
  });
  table.validateSelected(artifact, ["m.other"]); // unselected scenarios are not checked
});

test("expressionNames honors binders", () => {
  const expression = call("forall", nameExpr("xs"), lambda(call("eq", nameExpr("x"), nameExpr("limit")), "x"));
  assert.deepEqual(expressionNames(expression), ["xs", "limit"]);
  const letExpression = { kind: "let", name: "y", value: nameExpr("y"), body: nameExpr("y") };
  assert.deepEqual(expressionNames(letExpression), ["y"], "the let value sees the outer y only");
});
