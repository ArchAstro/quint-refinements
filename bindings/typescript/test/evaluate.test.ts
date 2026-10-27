import assert from "node:assert/strict";
import test from "node:test";

import {
  absent,
  bool,
  debug,
  equal,
  evaluateAllStepObligations,
  evaluateStepObligations,
  int,
  list,
  map,
  present,
  record,
  set,
  stateEvidence,
  text,
  tuple,
  variant,
  type RuntimeValue,
} from "../dist/index.js";
import { evaluateExpression, mergeObservedState, structuralDifference } from "../dist/evaluate.js";
import { assertion, boolExpr, call, emptyState, intExpr, lambda, nameExpr, noState, textExpr, type Expr } from "./helpers.ts";

const evaluate = (expression: Expr): RuntimeValue => evaluateExpression(expression, noState);

test("and and or stop at the deciding argument like Quint", () => {
  // `[][0]` fails when evaluated; Quint never reaches it here.
  const outOfBounds = call("nth", call("List"), intExpr(0));
  for (const [operator, first, want] of [
    ["and", false, false],
    ["actionAll", false, false],
    ["or", true, true],
    ["actionAny", true, true],
  ] as const) {
    assert.deepEqual(evaluate(call(operator, boolExpr(first), outOfBounds)), bool(want), operator);
  }
  assert.throws(() => evaluate(call("and", boolExpr(true), outOfBounds)), "a reached argument still fails");
  assert.deepEqual(evaluate(call("and", boolExpr(true), boolExpr(true))), bool(true));
  assert.deepEqual(evaluate(call("or", boolExpr(false), boolExpr(false))), bool(false));
  assert.throws(() => evaluate(call("and", intExpr(1))), /and accepts only normalized booleans/);
});

const setOf = (...values: Expr[]): Expr => call("Set", ...values);
const record12 = call("Rec", textExpr("a"), intExpr(1), textExpr("b"), intExpr(2));
const tup = (a: Expr, b: Expr): Expr => call("Tup", a, b);
const greaterThan = (limit: number): Expr => lambda(call("igt", nameExpr("x"), intExpr(limit)), "x");

const operatorCases: [name: string, expression: Expr, want: RuntimeValue][] = [
  ["eq", call("eq", intExpr(1), intExpr(1)), bool(true)],
  ["neq", call("neq", intExpr(1), intExpr(1)), bool(false)],
  ["not", call("not", boolExpr(false)), bool(true)],
  ["and", call("and", boolExpr(true), boolExpr(false)), bool(false)],
  ["or", call("or", boolExpr(false), boolExpr(true)), bool(true)],
  ["actionAll", call("actionAll", boolExpr(true), boolExpr(true)), bool(true)],
  ["actionAny", call("actionAny", boolExpr(false), boolExpr(false)), bool(false)],
  ["iadd", call("iadd", intExpr(2), intExpr(3)), int(5)],
  ["isub", call("isub", intExpr(2), intExpr(3)), int(-1)],
  ["ilt", call("ilt", intExpr(2), intExpr(3)), bool(true)],
  ["igt", call("igt", intExpr(2), intExpr(3)), bool(false)],
  ["ilte", call("ilte", intExpr(3), intExpr(3)), bool(true)],
  ["igte", call("igte", intExpr(2), intExpr(3)), bool(false)],
  ["iadd past 2^63 does not overflow", call("iadd", intExpr(9223372036854775807n), intExpr(1)), int(9223372036854775808n)],
  ["isub past -2^63 does not underflow", call("isub", intExpr(-9223372036854775808n), intExpr(1)), int(-9223372036854775809n)],
  ["set dedup", call("size", setOf(intExpr(1), intExpr(1), intExpr(2))), int(2)],
  ["size of list", call("size", call("List", intExpr(1))), int(1)],
  ["size of tuple", call("size", tup(intExpr(1), intExpr(2))), int(2)],
  ["size of map", call("size", call("Map", tup(textExpr("k"), intExpr(1)))), int(1)],
  ["size of record", call("size", record12), int(2)],
  ["contains", call("contains", setOf(intExpr(1)), intExpr(1)), bool(true)],
  ["union", call("union", setOf(intExpr(1)), setOf(intExpr(2))), set([int(1), int(2)])],
  ["exclude", call("exclude", setOf(intExpr(1), intExpr(2)), setOf(intExpr(2))), set([int(1)])],
  ["field", call("field", record12, textExpr("b")), int(2)],
  ["get missing field is Absent", call("get", record12, textExpr("z")), absent],
  ["with", call("field", call("with", record12, textExpr("a"), intExpr(9)), textExpr("a")), int(9)],
  ["set on a record", call("field", call("set", record12, textExpr("a"), intExpr(9)), textExpr("a")), int(9)],
  [
    "list ops",
    call("concat", call("append", call("List", intExpr(1)), intExpr(2)), call("List", intExpr(3))),
    list([int(1), int(2), int(3)]),
  ],
  ["length", call("length", call("List", intExpr(1), intExpr(2))), int(2)],
  ["nth", call("nth", call("List", intExpr(7), intExpr(8)), intExpr(1)), int(8)],
  ["indices", call("indices", call("List", intExpr(7), intExpr(8))), set([int(0), int(1)])],
  ["map get", call("get", call("Map", tup(textExpr("k"), intExpr(1))), textExpr("k")), int(1)],
  ["map put", call("size", call("put", call("Map"), textExpr("k"), intExpr(1))), int(1)],
  [
    "map set",
    call("get", call("set", call("Map", tup(textExpr("k"), intExpr(1))), textExpr("k"), intExpr(2)), textExpr("k")),
    int(2),
  ],
  ["keys", call("keys", call("Map", tup(textExpr("k"), intExpr(1)))), set([text("k")])],
  ["ite", call("ite", boolExpr(false), intExpr(1), intExpr(2)), int(2)],
  ["forall", call("forall", setOf(intExpr(1), intExpr(2)), greaterThan(0)), bool(true)],
  ["forall over a list", call("forall", call("List", intExpr(1), intExpr(2)), greaterThan(1)), bool(false)],
  ["exists", call("exists", setOf(intExpr(1), intExpr(2)), greaterThan(1)), bool(true)],
  ["exists over map values", call("exists", call("Map", tup(textExpr("k"), intExpr(5))), greaterThan(4)), bool(true)],
  ["exists over record values", call("exists", record12, greaterThan(1)), bool(true)],
  ["filter list", call("filter", call("List", intExpr(1), intExpr(2), intExpr(3)), greaterThan(1)), list([int(2), int(3)])],
  ["filter set", call("filter", setOf(intExpr(1), intExpr(2)), greaterThan(1)), set([int(2)])],
  [
    "map set",
    call("map", setOf(intExpr(1), intExpr(2)), lambda(call("iadd", nameExpr("x"), intExpr(10)), "x")),
    set([int(11), int(12)]),
  ],
  [
    "mapBy",
    call("get", call("mapBy", setOf(intExpr(1)), lambda(call("iadd", nameExpr("x"), intExpr(1)), "x")), intExpr(1)),
    int(2),
  ],
  [
    "fold",
    call("fold", setOf(intExpr(1), intExpr(2), intExpr(3)), intExpr(0), lambda(call("iadd", nameExpr("a"), nameExpr("x")), "a", "x")),
    int(6),
  ],
  ["let", { kind: "let", name: "x", value: intExpr(4), body: call("iadd", nameExpr("x"), nameExpr("x")) }, int(8)],
  ["Present", call("Present", intExpr(1)), present(int(1))],
  ["unknown uppercase operator builds a variant", call("Ok", intExpr(1)), variant("Ok", int(1))],
  ["variant", call("variant", textExpr("Tag"), intExpr(1)), variant("Tag", int(1))],
  ["Absent name defaults", nameExpr("Absent"), absent],
  ["disabled name", nameExpr("disabled"), bool(false)],
  [
    "matchVariant on unit",
    call("matchVariant", textExpr("B"), textExpr("A"), lambda(intExpr(1), "_"), textExpr("B"), lambda(intExpr(2), "_")),
    int(2),
  ],
  [
    "matchVariant default branch",
    call("matchVariant", call("C", intExpr(3)), textExpr("A"), lambda(intExpr(1), "_"), textExpr("_"), lambda(intExpr(2), "_")),
    int(2),
  ],
  [
    "matchVariant takes the first matching branch",
    call("matchVariant", textExpr("A"), textExpr("A"), lambda(intExpr(1), "_"), textExpr("_"), lambda(intExpr(2), "_")),
    int(1),
  ],
  [
    "matchVariant on Present",
    call("matchVariant", call("Present", intExpr(5)), textExpr("Absent"), lambda(intExpr(0), "_"), textExpr("Present"), lambda(nameExpr("v"), "v")),
    int(5),
  ],
  ["replicaPoolKey", call("field", call("replicaPoolKey", textExpr("r"), call("Rec")), textExpr("replica_id")), text("r")],
  ["Tup", call("Tup", intExpr(1), textExpr("a")), tuple([int(1), text("a")])],
  ["Rec with a repeated key keeps the last", call("field", call("Rec", textExpr("a"), intExpr(1), textExpr("a"), intExpr(2)), textExpr("a")), int(2)],
];

test("every evaluator operator", () => {
  for (const [name, expression, want] of operatorCases) {
    const got = evaluate(expression);
    assert.ok(equal(got, want), `${name}: got ${debug(got)}, want ${debug(want)}`);
  }
});

test("operator failures name the problem", () => {
  const cases: [name: string, expression: Expr, want: string][] = [
    ["nth out of bounds", call("nth", call("List"), intExpr(0)), "list index 0 is out of bounds"],
    ["nth negative", call("nth", call("List", intExpr(1)), intExpr(-1)), "list index -1 is out of bounds"],
    ["missing record field", call("field", call("Rec"), textExpr("x")), "runtime record has no field x"],
    ["missing map key", call("get", call("Map"), intExpr(1)), "map has no key Int(1)"],
    ["set adds no key", call("set", call("Map"), intExpr(1), intExpr(1)), "set cannot add missing map key Int(1)"],
    ["unknown operator", call("frobnicate", intExpr(1)), "unsupported runtime operator frobnicate for [Int(1)]"],
    ["ill-typed operands fall through", call("iadd", textExpr("a"), intExpr(1)), 'unsupported runtime operator iadd for [Text("a"), Int(1)]'],
    ["constructor arity", call("Ok", intExpr(1), intExpr(2)), "variant constructor Ok requires one value, received 2"],
    ["rec key", call("Rec", intExpr(1), intExpr(2)), "Rec key is not text"],
    ["rec pairs", call("Rec", textExpr("a")), "Rec requires key and value pairs"],
    ["map shape", call("Map", intExpr(1)), "Map accepts only key/value tuples"],
    ["map arity", call("Map", call("Tup", intExpr(1))), "Map entries must contain exactly two values"],
    ["ite condition", call("ite", intExpr(1), intExpr(1), intExpr(1)), "ite condition is not boolean"],
    ["ite arity", call("ite", boolExpr(true)), "ite requires a condition and two branches"],
    ["unsupported kind", { kind: "weird" }, "unsupported normalized expression kind"],
    ["unknown name", nameExpr("nope"), "unknown evidence name nope"],
    ["int without a value", { kind: "int" }, "normalized integer has no value"],
    ["int that is not integral", { kind: "int", value: 1.5 }, "normalized integer has no value"],
    ["matchVariant no branch", call("matchVariant", textExpr("C"), textExpr("A"), lambda(intExpr(1), "_")), "matchVariant has no matching branch"],
    ["matchVariant on a number", call("matchVariant", intExpr(1)), "matchVariant value is not a normalized variant"],
    ["lambda arity", call("fold", call("Set", intExpr(1)), intExpr(0), lambda(intExpr(0), "only")), "lambda expects 1 arguments, received 2"],
    ["filter input", call("filter", intExpr(1), greaterThan(0)), "filter input is not a list or set"],
    ["map input", call("map", call("List"), greaterThan(0)), "map input is not a set"],
    ["fold input", call("fold", call("List"), intExpr(0), lambda(intExpr(0), "a", "b")), "fold input is not a set"],
    ["quantifier input", call("forall", intExpr(1), greaterThan(0)), "forall input is not a collection"],
    ["quantifier predicate", call("forall", setOf(intExpr(1)), intExpr(1)), "forall predicate is not a lambda"],
    ["quantifier result", call("exists", setOf(intExpr(1)), lambda(intExpr(1), "x")), "exists predicate did not evaluate to boolean"],
    ["assign arity", call("assign", nameExpr("state")), "assign requires a variable and an expression"],
    ["call without operator", { kind: "call", arguments: [] }, "normalized call has no operator"],
    ["call without arguments", { kind: "call", operator: "List" }, "normalized call has no arguments"],
  ];
  for (const [name, expression, want] of cases) {
    assert.throws(() => evaluate(expression), (error: Error) => error.message.includes(want), `${name}: expected ${want}`);
  }
});

test("an evidence call answers before the built-in constructor rule", () => {
  const evidence = {
    resolveName: () => undefined,
    resolveCall: (operator: string, args: readonly RuntimeValue[]) => (operator === "Custom" ? int(args.length) : undefined),
  };
  assert.deepEqual(evaluateExpression(call("Custom", intExpr(1), intExpr(2)), evidence), int(2));
});

test("structuralDifference names the divergence", () => {
  const node = (role: string): RuntimeValue => record({ role: text(role) });
  const nodes = (role: string): RuntimeValue => map([[text("n1"), node(role)], [text("n2"), node("Leader")]]);
  const cases: [name: string, expected: RuntimeValue, observed: RuntimeValue, want: string][] = [
    ["map field", nodes("Follower"), nodes("Leader"), 'state.nodes["n1"].role expected Text("Follower"), observed Text("Leader")'],
    ["missing map key", nodes("Leader"), map([[text("n1"), node("Leader")]]), 'state.nodes["n2"] missing from observed state'],
    ["unexpected map key", map(), map([[int(3), int(1)]]), "state.nodes[3] unexpected in observed state"],
    ["compound map key", map([[tuple([int(1)]), int(1)]]), map(), "state.nodes[Tuple([Int(1)])] missing from observed state"],
    ["record fields", record({ a: int(1) }), record({ a: int(1), b: int(2) }), 'state.nodes record fields differ; missing [], unexpected ["b"]'],
    ["record key swapped", record({ a: int(1) }), record({ b: int(1) }), "state.nodes.a missing from observed state"],
    ["list length", list([int(1)]), list(), "state.nodes expected list length 1, observed 0"],
    ["list element", list([int(1)]), list([int(2)]), "state.nodes[0] expected Int(1), observed Int(2)"],
    ["scalar", int(1), text("1"), 'state.nodes expected Int(1), observed Text("1")'],
    ["present", present(int(1)), present(int(2)), "state.nodes expected Int(1), observed Int(2)"],
  ];
  for (const [name, expected, observed, want] of cases) {
    assert.equal(structuralDifference(expected, observed, "state.nodes"), want, name);
  }
  assert.equal(structuralDifference(nodes("Leader"), nodes("Leader"), "state"), undefined);
});

test("a map entry the implementation lacks is not filled in from the model", () => {
  const node = (role: string): RuntimeValue => record({ role: text(role) });
  const model = record({ nodes: map([[text("n1"), node("Leader")], [text("n2"), node("Leader")]]) });
  const observed = record({ nodes: map([[text("n1"), node("Leader")]]) });
  const merged = mergeObservedState(model, observed, new Set(["nodes"]));
  assert.equal(structuralDifference(model, merged, "state"), 'state.nodes["n2"] missing from observed state');
});

test("false assertions name the kind, context and expression", () => {
  const evidence = stateEvidence(record());
  const expression = call("eq", intExpr(1), intExpr(2));
  assert.throws(
    () => evaluateAllStepObligations("s.run", "act", [assertion(expression)], [], evidence, evidence, []),
    {
      message:
        'guard assertion evaluated false in s.run:act: {"arguments":[{"kind":"int","value":1},{"kind":"int","value":2}],"kind":"call","operator":"eq"}',
    },
  );
  assert.throws(
    () => evaluateAllStepObligations("s.run", "act", [], [assertion(intExpr(1))], evidence, evidence, []),
    (error: Error) => error.message.startsWith("next assertion did not evaluate to boolean in s.run:act: "),
  );
});

test("evaluation errors carry the scenario, action and kind as a prefix", () => {
  assert.throws(
    () => evaluateAllStepObligations("s.run", "act", [], [assertion(nameExpr("missing"))], emptyState, emptyState, []),
    { message: "s.run:act next: unknown evidence name missing" },
  );
});

test("unsupported dependencies fail closed", () => {
  const evidence = stateEvidence(record());
  const guard = assertion(boolExpr(true), "runtime", ["operator:igt"]);
  assert.throws(() => evaluateAllStepObligations("s.run", "act", [guard], [], evidence, evidence, []), {
    message: "s.run:act guard uses unsupported runtime dependency operator:igt",
  });
  assert.equal(evaluateAllStepObligations("s.run", "act", [guard], [], evidence, evidence, ["operator:igt"]), 1);
  // The built-in operators need no registration.
  const builtin = assertion(boolExpr(true), "runtime", ["operator:eq", "operator:assign"]);
  assert.equal(evaluateAllStepObligations("s.run", "act", [builtin], [], evidence, evidence, []), 1);
});

test("model-scope assertions are skipped only by the runtime entry points", () => {
  const evidence = stateEvidence(record());
  const modelOnly = [assertion(boolExpr(false), "model")];
  assert.throws(() => evaluateStepObligations("s", "a", modelOnly, [], evidence, evidence, []), {
    message: "s:a declared step obligations but evaluated none",
  });
  assert.throws(() => evaluateAllStepObligations("s", "a", modelOnly, [], evidence, evidence, []), {
    message: /guard assertion evaluated false/,
  });
});

test("guards see the state before the action and next sees the state after", () => {
  const before = stateEvidence(record({ n: int(1) }));
  const after = stateEvidence(record({ n: int(2) }));
  const field = call("field", nameExpr("state"), textExpr("n"));
  const guard = assertion(call("eq", field, intExpr(1)));
  const next = assertion(call("eq", field, intExpr(2)));
  assert.equal(evaluateAllStepObligations("s", "a", [guard], [next], before, after, []), 2);
  assert.throws(() => evaluateAllStepObligations("s", "a", [next], [guard], before, after, []));
});

test("the cases above exercise every operator in the shared vocabulary", async () => {
  const { expressionVocabulary } = await import("../dist/index.js");
  const used = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      const { operator } = value as { operator?: unknown };
      if (typeof operator === "string") {
        used.add(operator);
      }
      Object.values(value).forEach(visit);
    }
  };
  operatorCases.forEach(([, expression]) => visit(expression));
  used.add("assign"); // covered by the next test
  assert.deepEqual(
    expressionVocabulary.filter(operator => !used.has(operator)),
    [],
    "add a case for each operator the evaluator claims to implement",
  );
});

test("assign compares the model's next state with the observed one", () => {
  const before = stateEvidence(record({ balance: int(10) }));
  const after = (balance: number) => stateEvidence(record({ balance: int(balance) }));
  const assign = assertion(call("assign", nameExpr("state"), call("Rec", textExpr("balance"), intExpr(6))));
  assert.equal(evaluateAllStepObligations("bank.run", "withdraw", [], [assign], before, after(6), []), 1);
  assert.throws(() => evaluateAllStepObligations("bank.run", "withdraw", [], [assign], before, after(14), []), {
    message: "bank.run:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)",
  });
});

test("assign reads its right-hand side from the state before the action", () => {
  const before = stateEvidence(record({ balance: int(10) }));
  const after = stateEvidence(record({ balance: int(7) }));
  const balance = call("field", nameExpr("state"), textExpr("balance"));
  const assign = assertion(call("assign", nameExpr("state"), call("Rec", textExpr("balance"), call("isub", balance, intExpr(3)))));
  assert.equal(evaluateAllStepObligations("bank.run", "withdraw", [], [assign], before, after, []), 1);
});

test("an operator named like an Object.prototype member reaches the evidence", () => {
  const evidence = { resolveName: () => undefined, resolveCall: (operator: string) => (operator === "toString" ? int(42) : undefined) };
  assert.deepEqual(evaluateExpression(call("toString", intExpr(1)), evidence), int(42));
});

test("the constructor fallback uses Unicode Uppercase, as Rust does", () => {
  assert.deepEqual(evaluate(call("Ⓐ", intExpr(1))), variant("Ⓐ", int(1)));
});

test("an error thrown by evidence keeps its scenario context", () => {
  const evidence = { resolveName: (name: string) => { if (name === "boom") throw new Error("boom"); return undefined; } };
  assert.throws(
    () => evaluateAllStepObligations("s", "a", [], [assertion(nameExpr("boom"))], evidence, evidence, []),
    { message: "s:a next: boom" },
  );
});
