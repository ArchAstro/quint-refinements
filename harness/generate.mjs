// Runtime-neutral Quint-app → JSON artifact engine. Product vocabulary,
// source layout, retrieve policy, fixture imports, and ITF augmentation arrive
// through defineConformanceApp rather than living in this module.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const supportedNormalizedExpressionOperators = JSON.parse(
  fs.readFileSync(new URL("../expression_vocabulary.json", import.meta.url), "utf8"),
);
const supportedNormalizedExpressionOperatorSet = new Set(
  supportedNormalizedExpressionOperators,
);

export const schemaVersion = 2;

export let defaultAppConfig;

export function setDefaultConformanceApp(app) {
  defaultAppConfig = app;
}

export function defineConformanceApp(config) {
  const capabilities = [...config.capabilities];
  const actions = [...config.actions];
  const expressionOperators = [...(config.expressionOperators ?? [])];
  const expressionNames = [...(config.expressionNames ?? [])];
  return Object.freeze({
    ...config,
    capabilities,
    actions,
    expressionOperators,
    expressionNames,
    capabilitySet: new Set(capabilities),
    actionSet: new Set(actions),
    expressionOperatorSet: new Set(expressionOperators),
    expressionNameSet: new Set(expressionNames),
    modelOnlyNameSet: new Set(config.modelOnlyNames ?? []),
    modelOnlyOperatorSet: new Set(config.modelOnlyOperators ?? []),
    initializers: new Set(config.initializers),
    fixtureImports: [...(config.fixtureImports ?? [])],
    requireObserve: config.requireObserve ?? true,
    copySourceForFixtures: config.copySourceForFixtures ??
      (({ sourceText }) => sourceText),
    retrieveForCapabilities: config.retrieveForCapabilities ?? (() => new Set()),
    actionRetrieveForCapabilities: config.actionRetrieveForCapabilities ??
      config.retrieveForCapabilities ?? (() => new Set()),
    attachActionNext: config.attachActionNext ?? createItfActionNextHook(),
  });
}

function fail(context, message) {
  throw new Error(`${context}: ${message}`);
}

export function parseConformanceCapabilities(
  doc,
  context = "declaration",
  app = defaultAppConfig,
) {
  const directives = (doc ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("@conformance"));
  if (directives.length !== 1) {
    fail(context, `expected exactly one @conformance directive, found ${directives.length}`);
  }
  const match = directives[0].match(
    /^@conformance requires = \[([a-z0-9._]+(?:, [a-z0-9._]+)*)\]$/,
  );
  if (!match) {
    fail(context, "malformed @conformance directive");
  }
  const capabilities = match[1].split(", ");
  if (new Set(capabilities).size !== capabilities.length) {
    fail(context, "duplicate capability in @conformance directive");
  }
  for (const capability of capabilities) {
    if (!app.capabilitySet.has(capability)) {
      fail(context, `unknown conformance capability ${capability}`);
    }
  }
  return capabilities.sort();
}

export function encodeExpression(
  node,
  context = "expression",
  boundNames = new Set(),
  app = defaultAppConfig,
) {
  return encodeExpressionNode(node, context, boundNames, true, new Map(), app);
}

/// Guard conjuncts use the full Quint expression AST. Observe chapters keep
/// the closed adapter vocabulary.
export function encodeGuardExpression(
  node,
  context = "expression",
  boundNames = new Set(),
  defs = new Map(),
  app = defaultAppConfig,
) {
  return encodeExpressionNode(node, context, boundNames, false, defs, app);
}

function encodeExpressionNode(node, context, boundNames, closedVocab, defs, app) {
  if (!node || typeof node !== "object") {
    fail(context, "expected a Quint AST node");
  }

  if (["bool", "int", "str"].includes(node.kind)) {
    return { kind: node.kind, value: node.value };
  }
  if (node.kind === "name") {
    if (
      closedVocab &&
      !app.expressionNameSet.has(node.name) &&
      !boundNames.has(node.name)
    ) {
      fail(context, `unsupported expression name ${node.name}`);
    }
    if (!closedVocab && node.name === "disabled") {
      return { kind: "bool", value: false };
    }
    if (
      !closedVocab &&
      (defs.size > 0 || typeof defs.resolve === "function") &&
      !boundNames.has(node.name) &&
      node.name !== "state" &&
      node.name !== "Absent"
    ) {
      const definition = resolveDefinition(defs, node);
      if (
        (!definition || definition.qualifier === "val") &&
        /^[A-Z]/.test(node.name)
      ) {
        // Unit constructors (`CertificateValid`, `ReplicaUp`) are string tags.
        // Lowercase unresolved names are compatibility-mode local bindings;
        // keeping them as names leaves their conjunct model-scoped.
        return { kind: "str", value: node.name };
      }
    }
    return { kind: "name", value: node.name };
  }
  if (node.kind === "lambda") {
    const parameters = node.params.map(parameter => parameter.name);
    const nestedBoundNames = new Set([...boundNames, ...parameters]);
    return {
      kind: "lambda",
      parameters,
      body: encodeExpressionNode(
        node.expr,
        `${context}.body`,
        nestedBoundNames,
        closedVocab,
        defs,
        app,
      ),
    };
  }
  if (node.kind === "let") {
    const name = node.opdef?.name;
    const nestedBoundNames = new Set(boundNames);
    if (name) {
      nestedBoundNames.add(name);
    }
    return {
      kind: "let",
      name,
      value: encodeExpressionNode(
        node.opdef.expr,
        `${context}.let.value`,
        boundNames,
        closedVocab,
        defs,
        app,
      ),
      body: encodeExpressionNode(
        node.expr,
        `${context}.let.body`,
        nestedBoundNames,
        closedVocab,
        defs,
        app,
      ),
    };
  }
  if (node.kind === "app") {
    if (closedVocab && !app.expressionOperatorSet.has(node.opcode)) {
      fail(context, `unsupported expression operator ${node.opcode}`);
    }
    return {
      kind: "call",
      operator: node.opcode,
      arguments: (node.args ?? []).map((argument, index) =>
        encodeExpressionNode(
          argument,
          `${context}.${node.opcode}[${index}]`,
          boundNames,
          closedVocab,
          defs,
          app,
        )
      ),
    };
  }

  fail(context, `unsupported expression kind ${node.kind}`);
}

function expressionIsModelOnly(node, app = defaultAppConfig) {
  if (node.kind === "name") {
    return app.modelOnlyNameSet.has(node.name);
  }
  if (node.kind === "app") {
    return app.modelOnlyOperatorSet.has(node.opcode) ||
      node.args.some(argument => expressionIsModelOnly(argument, app));
  }
  if (node.kind === "lambda") {
    return expressionIsModelOnly(node.expr, app);
  }
  return false;
}

function shouldInlineDefinition(definition) {
  if (!definition?.expr) {
    return false;
  }
  // Nullary stateful `def` (selectionValue). `pureval` stays a fixture name.
  // `action disabled` encodes as `false` rather than expanding the action.
  return definition.qualifier === "def" && definition.expr.kind !== "lambda";
}

function collectNamedFixtures(node, names, defs, bound = new Set()) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.kind === "name") {
    if (!bound.has(node.name) && node.name !== "state" && node.name !== "Absent") {
      const definition = resolveDefinition(defs, node);
      const qualifier = definition?.qualifier;
      if (
        qualifier === "pureval" ||
        (qualifier === "puredef" && definition.expr?.kind !== "lambda")
      ) {
        names.add(node.name);
      }
    }
    return;
  }
  if (node.kind === "app") {
    (node.args ?? []).forEach(argument => collectNamedFixtures(argument, names, defs, bound));
    return;
  }
  if (node.kind === "lambda") {
    const nested = new Set(bound);
    (node.params ?? []).forEach(parameter => nested.add(parameter.name));
    collectNamedFixtures(node.expr, names, defs, nested);
    return;
  }
  if (node.kind === "let") {
    const nested = new Set(bound);
    if (node.opdef?.name) {
      nested.add(node.opdef.name);
    }
    collectNamedFixtures(node.opdef?.expr, names, defs, bound);
    collectNamedFixtures(node.expr, names, defs, nested);
  }
}

function collectUniverseFixtureNames(node, names, bound = new Set()) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.kind === "app" && node.opcode === "contains" && node.args?.[0]?.kind === "name") {
    if (!bound.has(node.args[0].name)) {
      names.add(node.args[0].name);
    }
  }
  if (node.kind === "app") {
    (node.args ?? []).forEach(argument =>
      collectUniverseFixtureNames(argument, names, bound)
    );
  } else if (node.kind === "lambda") {
    const nested = new Set(bound);
    (node.params ?? []).forEach(parameter => nested.add(parameter.name));
    collectUniverseFixtureNames(node.expr, names, nested);
  } else if (node.kind === "let") {
    const nested = new Set(bound);
    if (node.opdef?.name) {
      nested.add(node.opdef.name);
    }
    collectUniverseFixtureNames(node.opdef?.expr, names, bound);
    collectUniverseFixtureNames(node.expr, names, nested);
  }
}

function collectExpressionNames(node, names) {
  if (node.kind === "name") {
    names.add(node.name);
  } else if (node.kind === "app") {
    node.args.forEach(argument => collectExpressionNames(argument, names));
  } else if (node.kind === "lambda") {
    collectExpressionNames(node.expr, names);
    node.params.forEach(parameter => names.delete(parameter.name));
  } else if (node.kind === "let") {
    collectExpressionNames(node.opdef?.expr, names);
    collectExpressionNames(node.expr, names);
    if (node.opdef?.name) {
      names.delete(node.opdef.name);
    }
  }
}

function flattenThen(node) {
  if (node.kind === "app" && node.opcode === "then") {
    return [...flattenThen(node.args[0]), node.args[1]];
  }
  return [node];
}

function isStateSelfAssignment(node) {
  return node.kind === "app" &&
    node.opcode === "assign" &&
    node.args.length === 2 &&
    node.args[0].kind === "name" &&
    node.args[0].name === "state" &&
    node.args[1].kind === "name" &&
    node.args[1].name === "state";
}

function encodeObservation(node, context, app) {
  const assertions = [];
  let stateAssignmentCount = 0;

  for (const member of node.args) {
    if (member.kind === "app" && member.opcode === "assert" && member.args.length === 1) {
      const scope = expressionIsModelOnly(member.args[0], app) ? "model" : "runtime";
      const expression = encodeExpression(
        member.args[0],
        `${context}.assert[${assertions.length}]`,
        new Set(),
        app,
      );
      assertions.push({
        scope,
        expression,
        ...(scope === "runtime"
          ? { dependencies: observationDependencies(expression) }
          : {}),
      });
    } else if (isStateSelfAssignment(member)) {
      stateAssignmentCount += 1;
    } else {
      fail(context, "observation blocks may contain only assertions and state' = state");
    }
  }

  if (assertions.length === 0 || stateAssignmentCount !== 1) {
    fail(context, "observation blocks require assertions and exactly one state' = state");
  }
  return { kind: "observe", assertions };
}

function expressionPath(expression) {
  if (expression.kind === "name") {
    return expression.value;
  }
  if (
    expression.kind === "call" &&
    expression.operator === "field" &&
    expression.arguments.length === 2 &&
    expression.arguments[1].kind === "str"
  ) {
    const base = expressionPath(expression.arguments[0]);
    return base ? `${base}.${expression.arguments[1].value}` : undefined;
  }
  if (expression.kind === "call") {
    return expression.operator;
  }
  return undefined;
}

export function observationDependencies(expression, boundNames = new Set()) {
  const dependencies = new Set();

  function visit(node, bindings) {
    if (node.kind === "name") {
      if (!bindings.has(node.value)) {
        dependencies.add(`name:${node.value}`);
      }
      return;
    }
    if (node.kind === "lambda") {
      visit(node.body, new Set([...bindings, ...node.parameters]));
      return;
    }
    if (node.kind === "let") {
      visit(node.value, bindings);
      const nested = new Set(bindings);
      if (typeof node.name === "string") {
        nested.add(node.name);
      }
      visit(node.body, nested);
      return;
    }
    if (node.kind === "call") {
      dependencies.add(`operator:${node.operator}`);
      const path = expressionPath(node);
      if (node.operator === "field" && path) {
        dependencies.add(`path:${path}`);
      }
      node.arguments.forEach(argument => visit(argument, bindings));
    }
  }

  visit(expression, boundNames);
  return [...dependencies].sort();
}

export function validateRuntimeObservationDependencies(
  dependencies,
  context = "runtime observation dependency vocabulary",
  expectedDigest = defaultAppConfig?.runtimeObservationDependencyDigest,
) {
  const sorted = [...dependencies].sort();
  if (new Set(sorted).size !== sorted.length) {
    fail(context, "contains duplicate dependencies");
  }
  const digest = `sha256:${crypto.createHash("sha256").update(sorted.join("\0")).digest("hex")}`;
  if (expectedDigest && digest !== expectedDigest) {
    fail(
      context,
      `changed from reviewed digest ${expectedDigest} to ${digest}`,
    );
  }
  return digest;
}

function freeNames(node, bound = new Set()) {
  if (!node || typeof node !== "object") {
    return new Set();
  }
  if (node.kind === "name") {
    return bound.has(node.name) ? new Set() : new Set([node.name]);
  }
  if (node.kind === "app") {
    return new Set(
      (node.args ?? []).flatMap(argument => [...freeNames(argument, bound)]),
    );
  }
  if (node.kind === "lambda") {
    const nested = new Set(bound);
    (node.params ?? []).forEach(parameter => nested.add(parameter.name));
    return freeNames(node.expr, nested);
  }
  if (node.kind === "let") {
    const names = freeNames(node.opdef?.expr, bound);
    const nested = new Set(bound);
    if (node.opdef?.name) {
      nested.add(node.opdef.name);
    }
    return new Set([...names, ...freeNames(node.expr, nested)]);
  }
  return new Set();
}

function allNames(node) {
  if (!node || typeof node !== "object") {
    return new Set();
  }
  if (node.kind === "name") {
    return new Set([node.name]);
  }
  if (node.kind === "app") {
    return new Set((node.args ?? []).flatMap(argument => [...allNames(argument)]));
  }
  if (node.kind === "lambda") {
    return new Set([
      ...(node.params ?? []).map(parameter => parameter.name),
      ...allNames(node.expr),
    ]);
  }
  if (node.kind === "let") {
    return new Set([
      ...(node.opdef?.name ? [node.opdef.name] : []),
      ...allNames(node.opdef?.expr),
      ...allNames(node.expr),
    ]);
  }
  return new Set();
}

function renameBoundOccurrences(node, name, replacement, shadowed = false) {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (node.kind === "name") {
    return !shadowed && node.name === name ? { ...node, name: replacement } : node;
  }
  if (node.kind === "app") {
    return {
      ...node,
      args: (node.args ?? []).map(argument =>
        renameBoundOccurrences(argument, name, replacement, shadowed)
      ),
    };
  }
  if (node.kind === "lambda") {
    const nestedShadowed = shadowed ||
      (node.params ?? []).some(parameter => parameter.name === name);
    return {
      ...node,
      expr: renameBoundOccurrences(node.expr, name, replacement, nestedShadowed),
    };
  }
  if (node.kind === "let") {
    const bindsName = node.opdef?.name === name;
    return {
      ...node,
      opdef: node.opdef
        ? {
            ...node.opdef,
            expr: renameBoundOccurrences(
              node.opdef.expr,
              name,
              replacement,
              shadowed,
            ),
          }
        : node.opdef,
      expr: renameBoundOccurrences(
        node.expr,
        name,
        replacement,
        shadowed || bindsName,
      ),
    };
  }
  return node;
}

function freshBoundName(name, used) {
  let index = 1;
  let candidate = `${name}__inlined${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${name}__inlined${index}`;
  }
  used.add(candidate);
  return candidate;
}

function substituteNames(node, mapping) {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (node.kind === "name" && mapping.has(node.name)) {
    return mapping.get(node.name);
  }
  if (node.kind === "app") {
    return {
      ...node,
      args: (node.args ?? []).map(argument => substituteNames(argument, mapping)),
    };
  }
  if (node.kind === "lambda") {
    const substitutionFreeNames = new Set(
      [...mapping.values()].flatMap(value => [...freeNames(value)]),
    );
    const used = new Set([
      ...allNames(node),
      ...substitutionFreeNames,
      ...mapping.keys(),
    ]);
    let expression = node.expr;
    const parameters = (node.params ?? []).map(parameter => {
      if (!substitutionFreeNames.has(parameter.name)) {
        return parameter;
      }
      const replacement = freshBoundName(parameter.name, used);
      expression = renameBoundOccurrences(
        expression,
        parameter.name,
        replacement,
      );
      return { ...parameter, name: replacement };
    });
    const nested = new Map(mapping);
    for (const parameter of node.params ?? []) {
      nested.delete(parameter.name);
    }
    return { ...node, params: parameters, expr: substituteNames(expression, nested) };
  }
  if (node.kind === "let") {
    const name = node.opdef?.name;
    const substitutionFreeNames = new Set(
      [...mapping.values()].flatMap(value => [...freeNames(value)]),
    );
    const used = new Set([
      ...allNames(node),
      ...substitutionFreeNames,
      ...mapping.keys(),
    ]);
    const replacement = name && substitutionFreeNames.has(name)
      ? freshBoundName(name, used)
      : name;
    const expression = name && replacement !== name
      ? renameBoundOccurrences(node.expr, name, replacement)
      : node.expr;
    const nested = new Map(mapping);
    if (name) {
      nested.delete(name);
    }
    return {
      ...node,
      opdef: node.opdef
        ? {
            ...node.opdef,
            name: replacement,
            expr: substituteNames(node.opdef.expr, mapping),
          }
        : node.opdef,
      expr: substituteNames(expression, nested),
    };
  }
  return node;
}

function flattenActionAll(node, substituteLets = false, lets = new Map()) {
  if (node?.kind === "app" && node.opcode === "actionAll") {
    return (node.args ?? []).flatMap(argument =>
      flattenActionAll(argument, substituteLets, lets)
    );
  }
  if (node?.kind === "let") {
    if (!substituteLets) {
      return flattenActionAll(node.expr, false);
    }
    const nested = new Map(lets);
    if (node.opdef?.name) {
      nested.set(node.opdef.name, substituteNames(node.opdef.expr, lets));
    }
    return flattenActionAll(node.expr, true, nested);
  }
  const substituted = substituteLets ? substituteNames(node, lets) : node;
  return substituted ? [substituted] : [];
}

function isAssignment(node) {
  return node?.kind === "app" && node.opcode === "assign";
}

function encodedIsModelOnly(expression, app = defaultAppConfig) {
  if (expression?.kind === "name") {
    return app.modelOnlyNameSet.has(expression.value);
  }
  if (expression?.kind === "call") {
    return app.modelOnlyOperatorSet.has(expression.operator) ||
      (expression.arguments ?? []).some(argument => encodedIsModelOnly(argument, app));
  }
  if (expression?.kind === "lambda") {
    return encodedIsModelOnly(expression.body, app);
  }
  if (expression?.kind === "let") {
    return encodedIsModelOnly(expression.value, app) ||
      encodedIsModelOnly(expression.body, app);
  }
  return false;
}

export function classifyGuardAssertion(expression, retrieve, app = defaultAppConfig) {
  const dependencies = observationDependencies(expression);
  const runtime = !encodedIsModelOnly(expression, app) &&
    dependencies.every(dependency => retrieve.has(dependency));
  if (runtime) {
    return { scope: "runtime", expression, dependencies };
  }
  return { scope: "model", expression };
}

export function extractGuardAssertions(
  definition,
  argumentNodes,
  context,
  retrieve,
  app = defaultAppConfig,
) {
  return extractActionObligations(
    definition,
    argumentNodes,
    context,
    retrieve,
    undefined,
    new Map(),
    false,
    app,
  ).guards;
}

/// Split a Quint `all { }` action into unprimed conjuncts (before) and
/// `x' = e` assignments (after). `val`/`let` unwraps to its body; it is not
/// itself a conjunct.
export function extractActionObligations(
  definition,
  argumentNodes,
  context,
  retrieve,
  fixtureNames,
  defs = new Map(),
  deepInline = false,
  app = defaultAppConfig,
) {
  if (!definition) {
    return { guards: [], next: [] };
  }
  if (!definition.expr) {
    fail(context, "action definition has no body to encode as conjuncts");
  }
  let body = definition.expr;
  const mapping = new Map();
  if (body.kind === "lambda") {
    (body.params ?? []).forEach((parameter, index) => {
      if (argumentNodes[index]) {
        mapping.set(parameter.name, argumentNodes[index]);
      }
    });
    body = body.expr;
  }
  body = substituteNames(body, mapping);
  if (deepInline) {
    body = inlineExpr(body, defs, new Set(), context, true);
  }
  if (fixtureNames) {
    collectUniverseFixtureNames(body, fixtureNames);
    collectNamedFixtures(body, fixtureNames, defs);
  }
  const guards = [];
  const next = [];
  for (const [index, conjunct] of flattenActionAll(body, deepInline).entries()) {
    if (!conjunct) {
      continue;
    }
    const kind = isAssignment(conjunct) ? "next" : "guard";
    const encoded = encodeGuardExpression(
      conjunct,
      `${context}.${kind}[${index}]`,
      new Set(),
      defs,
      app,
    );
    const classified = classifyGuardAssertion(encoded, retrieve, app);
    if (kind === "next") {
      next.push(classified);
    } else {
      guards.push(classified);
    }
  }
  return { guards, next };
}

function encodeItfValue(value) {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return { kind: "str", value };
  }
  if (typeof value === "boolean") {
    return { kind: "bool", value };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { kind: "int", value };
  }
  if (typeof value === "object") {
    if (value["#bigint"] !== undefined) {
      const parsed = Number(value["#bigint"]);
      if (Number.isInteger(parsed)) {
        return { kind: "int", value: parsed };
      }
    }
    // Unit variants become string tags so next does not depend on the
    // closed observation name vocabulary (EnrollmentTokenCreated and
    // ConnectionOpened are model outcomes, not Observe names).
    if (
      typeof value.tag === "string" &&
      value.value?.["#tup"] &&
      value.value["#tup"].length === 0
    ) {
      return { kind: "str", value: value.tag };
    }
  }
  return undefined;
}

function itfInt(value) {
  if (value == null) {
    return 0;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "object" && value["#bigint"] !== undefined) {
    const parsed = Number(value["#bigint"]);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function encodedEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateFieldEq(field, encoded) {
  const expression = {
    kind: "call",
    operator: "eq",
    arguments: [
      {
        kind: "call",
        operator: "field",
        arguments: [
          { kind: "name", value: "state" },
          { kind: "str", value: field },
        ],
      },
      encoded,
    ],
  };
  return {
    scope: "runtime",
    expression,
    dependencies: observationDependencies(expression),
  };
}

export function createItfActionNextHook({ fields = [], mapCounters = [] } = {}) {
  return (steps, itf, context) => {
  const states = itf?.states;
  if (!Array.isArray(states) || states.length !== steps.length) {
    fail(
      context,
      `ITF state count ${states?.length ?? 0} does not match step count ${steps.length}`,
    );
  }
  for (const step of steps) {
    if (step.kind !== "action") {
      continue;
    }
    const after = states[step.index]?.state;
    const before = states[step.index - 1]?.state;
    if (!after) {
      fail(context, `missing ITF state for action ${step.action} at index ${step.index}`);
    }
    const next = [];
    for (const field of fields) {
      const encoded = encodeItfValue(after[field]);
      if (!encoded) {
        continue;
      }
      const previous = encodeItfValue(before?.[field]);
      if (encodedEqual(encoded, previous)) {
        continue;
      }
      next.push(stateFieldEq(field, encoded));
    }
    for (const counter of mapCounters) {
      const entries = after[counter.field]?.["#map"];
      const previousEntries = before?.[counter.field]?.["#map"];
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const [key, count] of entries) {
        const previous = Array.isArray(previousEntries)
          ? previousEntries.find(entry => entry[0] === key)?.[1]
          : undefined;
        const afterCount = itfInt(count);
        const beforeCount = itfInt(previous);
        if (afterCount === beforeCount || afterCount === undefined) {
          continue;
        }
        const keyExpression = counter.keyExpression(key);
        const encoded = encodeItfValue(count);
        if (!keyExpression || !encoded) {
          continue;
        }
        const expression = {
          kind: "call",
          operator: "eq",
          arguments: [
            {
              kind: "call",
              operator: "get",
              arguments: [
                {
                  kind: "call",
                  operator: "field",
                  arguments: [
                    { kind: "name", value: "state" },
                    { kind: "str", value: counter.field },
                  ],
                },
                keyExpression,
              ],
            },
            encoded,
          ],
        };
        next.push({
          scope: "runtime",
          expression,
          dependencies: observationDependencies(expression),
        });
      }
    }
    if (next.length === 0) {
      for (const field of fields) {
        const encoded = encodeItfValue(after[field]);
        if (encoded) {
          next.push(stateFieldEq(field, encoded));
          break;
        }
      }
    }
    if (next.length === 0 && !(step.next ?? []).length) {
      fail(context, `action ${step.action} produced no next from Quint assign or ITF`);
    }
    step.next = [...(step.next ?? []), ...next];
  }
  };
}

const primitiveOpcodes = new Set([
  "List",
  "Present",
  "Rec",
  "Set",
  "Tup",
  "actionAll",
  "actionAny",
  "and",
  "append",
  "assign",
  "contains",
  "eq",
  "exclude",
  "exists",
  "field",
  "filter",
  "fold",
  "forall",
  "get",
  "iadd",
  "igt",
  "ilt",
  "ilte",
  "igte",
  "indices",
  "ite",
  "length",
  "mapBy",
  "matchVariant",
  "neq",
  "not",
  "nth",
  "or",
  "set",
  "size",
  "union",
  "with",
]);

export function indexDefinitions(modules, table = {}) {
  const byName = new Map();
  for (const module of modules ?? []) {
    for (const declaration of module.declarations ?? []) {
      if (declaration.kind === "def" && declaration.name) {
        const declarations = byName.get(declaration.name) ?? [];
        if (!declarations.some(candidate => candidate.id === declaration.id)) {
          declarations.push(declaration);
        }
        byName.set(declaration.name, declarations);
      }
    }
  }
  return {
    resolve(node) {
      const resolved = table[String(node?.id)];
      if (resolved?.kind === "def") {
        return resolved;
      }
      const name = node?.kind === "name" ? node.name : node?.opcode;
      const declarations = byName.get(name) ?? [];
      return declarations.length === 1 ? declarations[0] : undefined;
    },
  };
}

function resolveDefinition(defs, node) {
  if (typeof defs?.resolve === "function") {
    return defs.resolve(node);
  }
  const name = node?.kind === "name" ? node.name : node?.opcode;
  return defs?.get?.(name);
}

function instantiateDef(
  definition,
  args,
  defs,
  stack,
  context,
  name,
  deepInline,
  bound,
) {
  const definitionKey = definition.id ?? `${definition.name}:${definition.qualifier}`;
  if (stack.has(definitionKey)) {
    fail(context, `recursive definition ${name}`);
  }
  stack.add(definitionKey);
  let body = definition.expr;
  const mapping = new Map();
  if (body.kind === "lambda") {
    (body.params ?? []).forEach((parameter, index) => {
      if (args[index]) {
        mapping.set(parameter.name, args[index]);
      }
    });
    body = body.expr;
  }
  const inlined = inlineExpr(
    substituteNames(body, mapping),
    defs,
    stack,
    context,
    deepInline,
    bound,
  );
  stack.delete(definitionKey);
  return inlined;
}

function inlineExpr(node, defs, stack, context, deepInline, bound = new Set()) {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (node.kind === "name") {
    if (bound.has(node.name)) {
      return node;
    }
    const definition = resolveDefinition(defs, node);
    if (shouldInlineDefinition(definition) && !primitiveOpcodes.has(node.name)) {
      return instantiateDef(
        definition,
        [],
        defs,
        stack,
        context,
        node.name,
        deepInline,
        bound,
      );
    }
    return node;
  }
  if (node.kind === "lambda") {
    const nested = new Set(bound);
    (node.params ?? []).forEach(parameter => nested.add(parameter.name));
    return {
      ...node,
      expr: inlineExpr(node.expr, defs, stack, context, deepInline, nested),
    };
  }
  if (node.kind === "let") {
    const nested = new Set(bound);
    if (node.opdef?.name) {
      nested.add(node.opdef.name);
    }
    return {
      ...node,
      opdef: node.opdef
        ? {
            ...node.opdef,
            expr: inlineExpr(
              node.opdef.expr,
              defs,
              stack,
              context,
              deepInline,
              bound,
            ),
          }
        : node.opdef,
      expr: inlineExpr(node.expr, defs, stack, context, deepInline, nested),
    };
  }
  if (node.kind !== "app") {
    return node;
  }
  const args = (node.args ?? []).map(argument =>
    inlineExpr(argument, defs, stack, context, deepInline, bound),
  );
  const definition = resolveDefinition(defs, node);
  if (!definition?.expr || primitiveOpcodes.has(node.opcode) || !deepInline) {
    return { ...node, args };
  }
  return instantiateDef(
    definition,
    args,
    defs,
    stack,
    context,
    node.opcode,
    deepInline,
    bound,
  );
}

function encodeAction(node, context, fixtureNames, defs, retrieve, deepInline, app) {
  let action;
  let args;
  if (node.kind === "name") {
    action = node.name;
    args = [];
  } else if (node.kind === "app") {
    action = node.opcode;
    args = node.args;
  } else {
    fail(context, `unsupported action expression kind ${node.kind}`);
  }

  if (!app.actionSet.has(action)) {
    fail(context, `unsupported action ${action}`);
  }
  args.forEach(argument => collectExpressionNames(argument, fixtureNames));
  const encoded = {
    kind: "action",
    action,
    arguments: args.map((argument, index) =>
      encodeExpression(argument, `${context}.${action}[${index}]`, new Set(), app)
    ),
  };
  const definition = resolveDefinition(defs, node);
  if (deepInline && !definition) {
    fail(context, `complete action ${action} has no compiled definition`);
  }
  const { guards, next } = extractActionObligations(
    definition,
    args,
    `${context}.${action}`,
    retrieve,
    fixtureNames,
    defs,
    deepInline,
    app,
  );
  if (guards.length > 0) {
    encoded.guards = guards;
  }
  if (next.length > 0) {
    encoded.next = next;
  }
  return encoded;
}

export function extractRun(
  declaration,
  source,
  moduleName,
  fixtureNames = new Set(),
  actionDefs = new Map(),
  fullyRefinedRuns = new Set(),
  app = defaultAppConfig,
) {
  const context = `${source}:${declaration.name}`;
  const requiredCapabilities = parseConformanceCapabilities(declaration.doc, context, app);
  const retrieve = app.actionRetrieveForCapabilities(requiredCapabilities);
  const deepInline = fullyRefinedRuns.has(`${moduleName}.${declaration.name}`);
  const nodes = flattenThen(declaration.expr);
  const initial = nodes.shift();
  if (
    initial?.kind !== "name" ||
    !app.initializers.has(initial.name)
  ) {
    fail(context, "run must begin with a supported initializer");
  }

  const steps = [{ kind: "init", action: initial.name, arguments: [] }];
  for (const [index, node] of nodes.entries()) {
    const context = `${source}:${declaration.name}:step ${index + 1}`;
    steps.push(
      node.kind === "app" && node.opcode === "actionAll"
        ? encodeObservation(node, context, app)
        : encodeAction(
            node,
            context,
            fixtureNames,
            actionDefs,
            retrieve,
            deepInline,
            app,
          ),
    );
  }

  if (app.requireObserve && !steps.some(step => step.kind === "observe")) {
    fail(context, "run has no asserted observation");
  }
  if (deepInline) {
    validateFullyRefinedOperators(steps, context);
  }

  return {
    source,
    module: moduleName,
    fixtureNamespace: moduleName,
    name: declaration.name,
    requiredCapabilities,
    steps: steps.map((step, index) => ({ index, ...step })),
  };
}

export function validateFullyRefinedOperators(steps, context = "fully refined run") {
  const operators = new Set();
  const visit = expression => {
    if (!expression || typeof expression !== "object") {
      return;
    }
    if (expression.kind === "call") {
      operators.add(expression.operator);
      expression.arguments.forEach(visit);
    } else if (expression.kind === "lambda") {
      visit(expression.body);
    } else if (expression.kind === "let") {
      visit(expression.value);
      visit(expression.body);
    }
  };
  for (const step of steps) {
    if (step.kind !== "action") {
      continue;
    }
    [...(step.guards ?? []), ...(step.next ?? [])]
      .forEach(assertion => visit(assertion.expression));
  }
  const unsupported = [...operators]
    .filter(operator => !supportedNormalizedExpressionOperatorSet.has(operator))
    .sort();
  if (unsupported.length > 0) {
    fail(context, `uses unsupported normalized operators ${unsupported.join(", ")}`);
  }
}

function compileScenario(quint, specDir, descriptor, outputPath) {
  const { source, module: moduleName, init, step } = descriptor;
  const result = spawnSync(
    quint,
    [
      "compile",
      source,
      `--main=${moduleName}`,
      `--init=${init}`,
      `--step=${step}`,
      "--target=json",
      "--flatten=false",
      `--out=${outputPath}`,
      "--verbosity=0",
    ],
    {
      cwd: specDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Quint compile failed for ${source}:\n${result.stderr ?? ""}`);
  }
  const compiled = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const module = compiled.modules.find(candidate => candidate.name === moduleName);
  if (!module) {
    throw new Error(`Quint compile did not return module ${moduleName}`);
  }
  return { module, modules: compiled.modules ?? [], table: compiled.table ?? {} };
}

function writeFixtureWorkspace(specDir, temporaryDir, app) {
  for (const source of fs.readdirSync(specDir).filter(file => file.endsWith(".qnt"))) {
    const sourceText = fs.readFileSync(path.join(specDir, source), "utf8");
    const copied = app.copySourceForFixtures({ source, sourceText });
    fs.writeFileSync(path.join(temporaryDir, source), copied);
  }
}

function concreteValue(node, context) {
  if (["bool", "int", "str"].includes(node.kind)) {
    return node.value;
  }
  if (node.kind === "name") {
    return { tag: node.name, value: { "#tup": [] } };
  }
  if (node.kind !== "app") {
    fail(context, `fixture evaluation produced unsupported kind ${node.kind}`);
  }

  const values = node.args.map((argument, index) =>
    concreteValue(argument, `${context}.${node.opcode}[${index}]`)
  );
  if (node.opcode === "Rec") {
    if (values.length % 2 !== 0) {
      fail(context, "record fixture has an odd number of entries");
    }
    return Object.fromEntries(
      Array.from({ length: values.length / 2 }, (_, index) => [
        values[index * 2],
        values[index * 2 + 1],
      ]),
    );
  }
  if (node.opcode === "Set") {
    return { "#set": values };
  }
  if (node.opcode === "List") {
    return values;
  }
  if (node.opcode === "Tup") {
    return { "#tup": values };
  }
  if (node.opcode === "Map") {
    return { "#map": values };
  }
  return {
    tag: node.opcode,
    value: values.length === 0
      ? { "#tup": [] }
      : values.length === 1
        ? values[0]
        : { "#tup": values },
  };
}

function resolveFixtures(quint, temporaryDir, source, moduleName, fixtureNames, app) {
  if (fixtureNames.size === 0) {
    return {};
  }
  const sortedNames = [...fixtureNames].sort();
  const recordExpression = `{ ${sortedNames.map((name, index) => `fixture_${index}: ${name}`).join(", ")} }`;
  // Fixture values are pure Quint expressions. Keep evaluation in-process so
  // first-use Rust backend download progress cannot contaminate captured stdout.
  const evaluation = spawnSync(
    quint,
    [
      "-q",
      "--backend=typescript",
      "-r",
      `${source}::${moduleName}`,
      recordExpression,
    ],
    {
      cwd: temporaryDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (
    evaluation.status !== 0 ||
    /(^|\n)(syntax |static analysis |runtime )?error:/im.test(evaluation.stdout)
  ) {
    throw new Error(
      `Quint fixture evaluation failed for ${moduleName}:\n${evaluation.stdout ?? ""}${evaluation.stderr ?? ""}`,
    );
  }

  const captureSource = [
    "module conformance_fixture_capture {",
    ...app.fixtureImports.map(entry => {
      const fixtureModule = typeof entry === "string" ? entry : entry.module;
      const fixtureSource = typeof entry === "string" ? entry : entry.source;
      return `  import ${fixtureModule}.* from "./${fixtureSource}"`;
    }),
    `  import ${moduleName}.* from "./${path.basename(source, ".qnt")}"`,
    `  pure val exportedFixtures = ${evaluation.stdout.trim()}`,
    "  var dummy: bool",
    "  action __conformance_capture_init = dummy' = false",
    "  action __conformance_capture_step = dummy' = dummy",
    "}",
    "",
  ].join("\n");
  const captureSourcePath = path.join(temporaryDir, "conformance_fixture_capture.qnt");
  const captureOutputPath = path.join(temporaryDir, "conformance_fixture_capture.json");
  fs.writeFileSync(captureSourcePath, captureSource);
  const capture = spawnSync(
    quint,
    [
      "compile",
      path.basename(captureSourcePath),
      "--main=conformance_fixture_capture",
      "--init=__conformance_capture_init",
      "--step=__conformance_capture_step",
      "--target=json",
      "--flatten=false",
      `--out=${captureOutputPath}`,
      "--verbosity=0",
    ],
    {
      cwd: temporaryDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (capture.status !== 0) {
    const compilerOutput = fs.existsSync(captureOutputPath)
      ? fs.readFileSync(captureOutputPath, "utf8")
      : "no compiler output file";
    let compilerErrors = compilerOutput;
    try {
      const parsed = JSON.parse(compilerOutput);
      compilerErrors = (parsed.errors ?? []).map(error => error.explanation).join("\n");
    } catch {
      // Preserve non-JSON compiler output verbatim.
    }
    throw new Error(
      `Quint fixture capture failed for ${moduleName} (status ${capture.status}, signal ${capture.signal}, error ${capture.error?.message ?? "none"}):\n${capture.stderr ?? ""}\n${compilerErrors}`,
    );
  }
  const compiled = JSON.parse(fs.readFileSync(captureOutputPath, "utf8"));
  const captureModule = compiled.modules.find(module => module.name === "conformance_fixture_capture");
  const declaration = captureModule?.declarations.find(
    candidate => candidate.name === "exportedFixtures",
  );
  if (!declaration) {
    throw new Error(`fixture capture did not return exportedFixtures for ${moduleName}`);
  }
  const indexedFixtures = concreteValue(declaration.expr, `${moduleName}.fixtures`);
  return Object.fromEntries(
    sortedNames.map((name, index) => [name, indexedFixtures[`fixture_${index}`]]),
  );
}

function digestModel(specDir) {
  const sources = fs.readdirSync(specDir)
    .filter(file => file.endsWith(".qnt"))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const source of sources) {
    hash.update(source);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(specDir, source)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function validateFullyRefinedRuns(fullyRefinedRuns, scenarios) {
  const available = new Set(
    scenarios.map(scenario => `${scenario.module}.${scenario.name}`),
  );
  const unknown = [...fullyRefinedRuns]
    .filter(run => !available.has(run))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`unknown fully refined runs: ${unknown.join(", ")}`);
  }
}

export function validateAppSources(app, sources) {
  const identities = new Set();
  for (const descriptor of sources) {
    const { source, module, init, step } = descriptor;
    if (![source, module, init, step].every(value => typeof value === "string" && value)) {
      throw new Error("Quint app sources require source, module, init, and step");
    }
    const identity = `${source}\0${module}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate Quint app source ${source} module ${module}`);
    }
    identities.add(identity);
    if (!app.initializers.has(init)) {
      throw new Error(`source ${source} uses unsupported initializer ${init}`);
    }
  }
}

export function generateConformanceTraces({
  root,
  specDir,
  fullyRefinedRuns = new Set(),
  app = defaultAppConfig,
}) {
  const quint = path.join(root, "node_modules/.bin/quint");
  const sources = app.sources(specDir);
  validateAppSources(app, sources);
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "quint-conformance-"));

  try {
    writeFixtureWorkspace(specDir, temporaryDir, app);
    const scenarios = [];
    const fixtures = {};
    for (const descriptor of sources) {
      const { source } = descriptor;
      const outputPath = path.join(temporaryDir, `${source}.json`);
      const { module, modules, table } = compileScenario(
        quint,
        specDir,
        descriptor,
        outputPath,
      );
      const actionDefs = indexDefinitions(modules, table);
      const fixtureNames = new Set();
      for (const declaration of module.declarations) {
        if (declaration.kind === "def" && declaration.qualifier === "run") {
          scenarios.push(
            extractRun(
              declaration,
              source,
              module.name,
              fixtureNames,
              actionDefs,
              fullyRefinedRuns,
              app,
            ),
          );
        }
      }
      fixtures[module.name] = resolveFixtures(
        quint,
        temporaryDir,
        source,
        module.name,
        fixtureNames,
        app,
      );
      const itfDir = path.join(temporaryDir, `${module.name}-itf`);
      fs.mkdirSync(itfDir, { recursive: true });
      const test = spawnSync(
        quint,
        [
          "test",
          source,
          `--main=${module.name}`,
          "--match=Run$",
          "--seed=0xdeadc01b",
          "--max-samples=1",
          "--backend=typescript",
          `--out-itf=${path.join(itfDir, "out_{test}_{seq}.itf.json")}`,
          "--verbosity=0",
        ],
        {
          cwd: specDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (test.status !== 0) {
        throw new Error(
          `Quint test traces failed for ${source}:\n${test.stderr ?? ""}${test.stdout ?? ""}`,
        );
      }
      const traces = new Map(
        fs.readdirSync(itfDir)
          .filter(file => file.endsWith(".itf.json"))
          .map(file => {
            const match = file.match(/^out_(.+)_(\d+)\.itf.json$/);
            const parsed = JSON.parse(fs.readFileSync(path.join(itfDir, file), "utf8"));
            return [match?.[1] ?? file, parsed];
          }),
      );
      for (const scenario of scenarios.filter(candidate => candidate.module === module.name)) {
        const itf = traces.get(scenario.name);
        if (!itf) {
          throw new Error(`missing ITF trace for ${scenario.module}.${scenario.name}`);
        }
        if (fullyRefinedRuns.has(`${scenario.module}.${scenario.name}`)) {
          const initialState = itf.states?.[0]?.state;
          if (!initialState) {
            throw new Error(
              `missing Quint initial state for fully refined run ${scenario.module}.${scenario.name}`,
            );
          }
          scenario.initialState = initialState;
        }
        app.attachActionNext(
          scenario.steps,
          itf,
          `${scenario.source}:${scenario.name}`,
        );
      }
    }
    if (scenarios.length === 0) {
      throw new Error("no asserted Quint runs were discovered");
    }
    validateFullyRefinedRuns(fullyRefinedRuns, scenarios);
    const usedCapabilities = new Set(
      scenarios.flatMap(scenario => scenario.requiredCapabilities),
    );
    const unusedCapabilities = app.capabilities.filter(
      capability => !usedCapabilities.has(capability),
    );
    if (unusedCapabilities.length > 0) {
      throw new Error(`unused conformance capabilities: ${unusedCapabilities.join(", ")}`);
    }
    const runtimeObservationDependencies = [...new Set(
      scenarios.flatMap(scenario =>
        scenario.steps
          .filter(step => step.kind === "observe")
          .flatMap(step => step.assertions)
          .filter(assertion => assertion.scope === "runtime")
          .flatMap(assertion => assertion.dependencies)
      ),
    )].sort();
    const runtimeObservationDependencyDigest = validateRuntimeObservationDependencies(
      runtimeObservationDependencies,
      "runtime observation dependency vocabulary",
      app.runtimeObservationDependencyDigest,
    );
    return {
      schemaVersion,
      modelDigest: digestModel(specDir),
      vocabulary: {
        actions: app.actions,
        capabilities: app.capabilities,
        expressionOperators: app.expressionOperators,
        expressionNames: app.expressionNames,
        refinementExpressionOperators: supportedNormalizedExpressionOperators,
        runtimeObservationDependencies,
        runtimeObservationDependencyDigest,
      },
      fixtures,
      scenarios,
    };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}
