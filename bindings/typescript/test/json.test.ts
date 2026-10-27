import assert from "node:assert/strict";
import test from "node:test";

import { jsonString, parseJson } from "../dist/index.js";

test("parseJson keeps integers exact and other numbers as floats", () => {
  assert.equal(parseJson("12345678901234567890123"), 12345678901234567890123n);
  assert.equal(parseJson("-0"), 0n);
  assert.equal(parseJson("1.5"), 1.5);
  assert.equal(parseJson("1e2"), 100);
});

test("parseJson decodes strings, escapes and nesting", () => {
  assert.equal(
    jsonString(parseJson(' [ "a\\n\\u00e9\\ud83d\\ude00", true, false, null, {} ] ')),
    '["a\\né😀",true,false,null,{}]',
  );
});

test("parseJson rejects malformed documents", () => {
  for (const bad of ["", "{", "[1,]", '{"a" 1}', "tru", '"\\x"', "1 2", "01", '{"a":1,}', '"line\nbreak"']) {
    assert.throws(() => parseJson(bad), Error, JSON.stringify(bad));
  }
});

test("an object key named __proto__ is ordinary data", () => {
  const parsed = parseJson('{"__proto__": 1, "b": 2}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["__proto__", "b"]);
  assert.equal(Object.getPrototypeOf(parsed), null);
});

test("jsonString sorts keys compactly like serde_json", () => {
  assert.equal(jsonString(parseJson('{"b": [1, {"d": 1, "c": "x"}], "a": null, "é": true}')), '{"a":null,"b":[1,{"c":"x","d":1}],"é":true}');
  assert.equal(jsonString(123456789012345678901234567890n), "123456789012345678901234567890");
});
