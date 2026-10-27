import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { expressionVocabulary } from "../dist/index.js";

test("the evaluator implements exactly the operators the compiler publishes", () => {
  for (const path of [
    "packages/compiler/expression_vocabulary.json",
    "bindings/rust/expression_vocabulary.json",
    "bindings/go/expression_vocabulary.json",
  ]) {
    const published = JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")) as string[];
    assert.deepEqual([...expressionVocabulary], published, path);
  }
});
