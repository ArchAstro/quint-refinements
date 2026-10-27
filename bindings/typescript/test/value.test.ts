import assert from "node:assert/strict";
import test from "node:test";

import {
  absent,
  bool,
  compare,
  debug,
  equal,
  fromItfText,
  int,
  list,
  map,
  mapGet,
  present,
  record,
  set,
  setContains,
  text,
  textSet,
  tuple,
  variant,
  type RuntimeValue,
} from "../dist/index.js";

test("compare follows the Rust derived ordering: variant rank first, then content", () => {
  // bool < int < text < set < list < tuple < map < record < variant < absent < present.
  const ordered: RuntimeValue[] = [
    bool(false), bool(true),
    int(-1), int(2),
    text("a"), text("b"),
    set(), set([int(1)]), set([int(1), int(2)]), set([int(2)]),
    list(), list([int(1)]), list([int(1), int(1)]), list([int(2)]),
    tuple(),
    map(), map([[text("a"), int(1)]]), map([[text("a"), int(2)]]),
    record(), record({ a: int(1) }), record({ a: int(1), b: int(0) }), record({ b: int(0) }),
    variant("A", int(1)), variant("B", int(0)),
    absent,
    present(int(0)), present(int(1)),
  ];
  ordered.forEach((left, i) => {
    ordered.forEach((right, j) => {
      assert.equal(compare(left, right), Math.sign(i - j), `compare(${debug(left)}, ${debug(right)})`);
    });
  });
});

test("integers are unbounded and compare exactly beyond 2^53", () => {
  const big = 9007199254740993n;
  assert.equal(compare(int(big), int(big + 1n)), -1);
  assert.equal(compare(int(big), int(9007199254740992n)), 1);
  assert.equal(debug(int(2n ** 100n)), "Int(1267650600228229401496703205376)");
  assert.throws(() => int(2 ** 60), /not a safe integer/);
});

test("text orders by code point, which is UTF-8 byte order", () => {
  // In UTF-16, U+10000 (a surrogate pair) sorts before U+FF5E; in UTF-8 it sorts after.
  assert.equal(compare(text("\u{10000}"), text("～")), 1);
  assert.equal(compare(text("a"), text("ab")), -1);
});

test("sets and maps are canonical", () => {
  assert.ok(equal(set([int(2), int(1), int(2)]), set([int(1), int(2)])), "sets ignore order and duplicates");
  const m = map([[text("b"), int(1)], [text("a"), int(2)], [text("b"), int(3)]]);
  assert.equal(m.entries.length, 2, "duplicate keys collapse");
  assert.deepEqual(mapGet(m, text("b")), int(3), "the last entry wins");
  assert.equal(setContains(set([int(1)]), int(1)), true);
  assert.equal(setContains(set([int(1)]), int(2)), false);
});

test("records iterate in field-name order whatever the construction order", () => {
  const value = record({ b: int(1), a: int(2) });
  assert.deepEqual([...value.fields.keys()], ["a", "b"]);
  assert.ok(equal(value, record([["a", int(2)], ["b", int(1)]])));
});

test("debug matches Rust's Debug output", () => {
  const value = record({
    flag: bool(true),
    n: int(-3),
    tags: textSet(["b", "a"]),
    items: list([text('x"y\n'), tuple()]),
    map: map([[int(1), present(absent)]]),
    var: variant("Ok", int(1)),
  });
  const want =
    'Record({"flag": Bool(true), "items": List([Text("x\\"y\\n"), Tuple([])]), ' +
    '"map": Map({Int(1): Present(Absent)}), "n": Int(-3), "tags": Set({Text("a"), Text("b")}), ' +
    '"var": Variant { tag: "Ok", value: Int(1) }})';
  assert.equal(debug(value), want);
  assert.equal(debug(text("tab\t nul\0 bell\u0007 é")), 'Text("tab\\t nul\\0 bell\\u{7} é")');
});

test("fromItfText decodes every ITF shape", () => {
  const cases: { name: string; input: string; want?: RuntimeValue; error?: string }[] = [
    { name: "bool", input: "true", want: bool(true) },
    { name: "int", input: "-4", want: int(-4) },
    { name: "bigint", input: '{"#bigint": "9007199254740993"}', want: int(9007199254740993n) },
    { name: "bigint beyond i64", input: '{"#bigint": "92233720368547758080"}', want: int(92233720368547758080n) },
    { name: "integer literal beyond 2^53", input: "9007199254740993", want: int(9007199254740993n) },
    { name: "bad bigint", input: '{"#bigint": "1.5"}', error: "ITF #bigint is not an integer" },
    { name: "float", input: "1.5", error: "outside normalized integer range" },
    { name: "null", input: "null", error: "ITF null has no Quint runtime value" },
    { name: "text", input: '"hi"', want: text("hi") },
    { name: "list", input: "[1, 2]", want: list([int(1), int(2)]) },
    { name: "tuple", input: '{"#tup": [1, "a"]}', want: tuple([int(1), text("a")]) },
    { name: "set", input: '{"#set": [2, 1, 2]}', want: set([int(1), int(2)]) },
    { name: "map", input: '{"#map": [["a", 1]]}', want: map([[text("a"), int(1)]]) },
    { name: "map entry shape", input: '{"#map": [["a"]]}', error: "ITF #map entry is not a key/value pair" },
    { name: "map entry kind", input: '{"#map": [1]}', error: "ITF #map entry is not an array" },
    { name: "map kind", input: '{"#map": 1}', error: "ITF #map is not an array" },
    { name: "tuple kind", input: '{"#tup": 1}', error: "ITF #tup is not an array" },
    { name: "unit variant is text", input: '{"tag": "Idle", "value": {"#tup": []}}', want: text("Idle") },
    { name: "payload variant", input: '{"tag": "Ok", "value": 1}', want: variant("Ok", int(1)) },
    { name: "variant tag", input: '{"tag": 1, "value": 1}', error: "ITF variant tag is not text" },
    { name: "absent", input: '{"tag": "Absent", "value": {"#tup": []}}', want: absent },
    { name: "present", input: '{"tag": "Present", "value": 1}', want: present(int(1)) },
    { name: "record drops meta", input: '{"a": 1, "#meta": {}, "__x": 1}', want: record({ a: int(1) }) },
    { name: "malformed", input: "{", error: "invalid ITF JSON" },
  ];
  for (const { name, input, want, error } of cases) {
    if (error !== undefined) {
      assert.throws(() => fromItfText(input), { message: new RegExp(error.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")) }, name);
    } else {
      assert.ok(equal(fromItfText(input), want!), `${name}: got ${debug(fromItfText(input))}`);
    }
  }
});

test("fields named like Object.prototype members are ordinary fields", () => {
  const value = fromItfText('{"ok": 1, "constructor": 2, "toString": 3}');
  assert.deepEqual(value.kind === "record" ? [...value.fields.keys()] : [], ["constructor", "ok", "toString"]);
});
