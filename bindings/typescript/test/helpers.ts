import { type Evidence, type Json, parseJson, stateEvidence, record } from "../dist/index.js";
import type { ArtifactAssertion } from "../dist/index.js";

// Expression builders for tests: they produce the decoded-JSON shape the
// evaluator interprets, with integers as bigint like the artifact parser.

export type Expr = { [key: string]: Json };

export function call(operator: string, ...args: Json[]): Expr {
  return { kind: "call", operator, arguments: args };
}
export const intExpr = (value: bigint | number): Expr => ({ kind: "int", value: BigInt(value) });
export const textExpr = (value: string): Expr => ({ kind: "str", value });
export const boolExpr = (value: boolean): Expr => ({ kind: "bool", value });
export const nameExpr = (value: string): Expr => ({ kind: "name", value });
export const lambda = (body: Json, ...parameters: string[]): Expr => ({ kind: "lambda", parameters, body });

export function assertion(expression: Json, scope: "runtime" | "model" = "runtime", dependencies: string[] = []): ArtifactAssertion {
  return { scope, expression, dependencies };
}

/** Evidence that resolves nothing. */
export const noState: Evidence = { resolveName: () => undefined };

/** Evidence whose state is an empty record. */
export const emptyState: Evidence = stateEvidence(record({}));

export function parse(text: string): Json {
  return parseJson(text);
}

export const minimalArtifact = `{
  "schemaVersion": 2,
  "modelDigest": "sha256:test",
  "vocabulary": {
    "actions": ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"],
    "capabilities": ["transport.basic"],
    "expressionOperators": [],
    "expressionNames": [],
    "runtimeObservationDependencies": [],
    "runtimeObservationDependencyDigest": "sha256:test"
  },
  "fixtures": { "m": {} },
  "scenarios": [{
    "source": "m.qnt",
    "module": "m",
    "fixtureNamespace": "m",
    "name": "run",
    "requiredCapabilities": ["transport.basic"],
    "steps": [
      {"index": 0, "kind": "init", "action": "init", "arguments": []},
      {"index": 1, "kind": "action", "action": "submitInvocation", "arguments": []},
      {"index": 2, "kind": "action", "action": "selectForAttempt", "arguments": []},
      {"index": 3, "kind": "action", "action": "enqueueSelectedDelivery", "arguments": []}
    ]
  }]
}`;
