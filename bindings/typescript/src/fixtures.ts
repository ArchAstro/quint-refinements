import { type ArtifactScenario, type ConformanceArtifact, scenarioId } from "./artifact.js";
import { fail } from "./error.js";
import type { Evidence } from "./evidence.js";
import {
  compareStrings,
  field as jsonField,
  isObject,
  type Json,
  jsonString,
  kindOf,
  normalizeJson,
  sortedKeys,
} from "./json.js";
import { debugStrings, fromItfJson, int, set, text, type RuntimeValue } from "./value.js";

/**
 * A value that owns one Quint fixture name.
 *
 * Implement it on the production type, not a test twin.
 * {@link FixtureTable.validate} compares `artifactJson()` to the generated
 * JSON so field drift fails closed.
 */
export interface QuintFixture {
  /**
   * The JSON shape expected in the generated artifact. Any JSON-compatible
   * value works: numbers, bigints, strings, booleans, arrays and plain objects.
   */
  artifactJson(): unknown;
  /** The corresponding normalized evaluator value. */
  runtimeValue(): RuntimeValue;
}

/** A Quint `int` fixture. */
export function intFixture(value: bigint | number): QuintFixture {
  return { artifactJson: () => BigInt(value), runtimeValue: () => int(value) };
}

/** A Quint `str` fixture or unit constructor name. */
export function textFixture(value: string): QuintFixture {
  return { artifactJson: () => value, runtimeValue: () => text(value) };
}

/** Named Quint fixtures backed by production values, one namespace per model module. */
export class FixtureTable {
  readonly namespace: string;
  private readonly values = new Map<string, RuntimeValue>();
  private readonly json = new Map<string, Json>();

  /** Creates an empty table for a Quint module namespace. */
  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /**
   * Creates a table that gives every fixture in a namespace the value the
   * Quint model defines for it.
   *
   * Use this when the model's constants are plain data. Follow it with
   * {@link insert} or {@link insertSet} to hand a name to a production value
   * instead, so that value is checked against the model.
   */
  static fromArtifact(namespace: string, artifact: ConformanceArtifact): FixtureTable {
    const table = new FixtureTable(namespace);
    const fixtures = artifact.fixtures[namespace];
    if (fixtures === undefined) {
      return table;
    }
    for (const name of sortedKeys(fixtures)) {
      try {
        table.values.set(name, fromItfJson(fixtures[name]!));
      } catch (error) {
        return fail(`fixture ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      table.json.set(name, fixtures[name]!);
    }
    return table;
  }

  /** Adds one named fixture value and returns the table for chaining. */
  insert(name: string, fixture: QuintFixture): this {
    this.values.set(name, fixture.runtimeValue());
    this.json.set(name, normalizeJson(fixture.artifactJson()));
    return this;
  }

  /** Adds one named finite set of fixture values and returns the table. */
  insertSet(name: string, ...members: readonly QuintFixture[]): this {
    const jsonMembers = members.map(member => normalizeJson(member.artifactJson()));
    jsonMembers.sort((a, b) => compareStrings(jsonString(a), jsonString(b)));
    this.values.set(name, set(members.map(member => member.runtimeValue())));
    this.json.set(name, jsonMembers);
    return this;
  }

  /** Looks up a fixture by its generated Quint name. */
  get(name: string): RuntimeValue | undefined {
    return this.values.get(name);
  }

  /** Reports whether the table owns a generated Quint name. */
  containsName(name: string): boolean {
    return this.values.has(name);
  }

  /** All owned fixture names in deterministic order. */
  names(): string[] {
    return [...this.values.keys()].sort(compareStrings);
  }

  /** Fixture names in generated retrieve-dependency form. */
  retrieveNames(): string[] {
    return this.names().map(name => `name:${name}`);
  }

  /**
   * Requires owned entries to exist in the artifact with matching JSON. Extra
   * artifact fixtures (other records in the same Quint module) are allowed.
   * Record comparison is key-subset: the owned keys must exist on the Quint
   * object with equal values, so `organization_id` versus `id` fails.
   */
  validateEntries(artifact: ConformanceArtifact): void {
    const expected = artifact.fixtures[this.namespace];
    if (expected === undefined) {
      return fail(`fixture namespace ${this.namespace} is missing from the artifact`);
    }
    for (const name of [...this.json.keys()].sort(compareStrings)) {
      const artifactJson = expected[name];
      if (artifactJson === undefined) {
        return fail(`artifact namespace ${this.namespace} is missing fixture ${name}`);
      }
      const owned = this.json.get(name)!;
      if (!fixtureJsonMatches(owned, artifactJson, false)) {
        return fail(`fixture ${name} JSON diverged: artifact ${jsonString(artifactJson)} rust ${jsonString(owned)}`);
      }
    }
  }

  /** Requires every JSON fixture in this namespace to have an owner with equal JSON. */
  validate(artifact: ConformanceArtifact): void {
    this.validateSelected(artifact, []);
  }

  /**
   * Requires every namespace fixture to have an owner and validates
   * normalized names only in the scenario runners selected by this proof. An
   * empty selection validates every scenario in the namespace.
   */
  validateSelected(artifact: ConformanceArtifact, scenarioIds: readonly string[]): void {
    const expected = artifact.fixtures[this.namespace];
    if (expected === undefined) {
      return fail(`fixture namespace ${this.namespace} is missing from the artifact`);
    }
    const artifactNames = sortedKeys(expected);
    const ownedNames = [...this.json.keys()].sort(compareStrings);
    if (artifactNames.length !== ownedNames.length || artifactNames.some((name, index) => name !== ownedNames[index])) {
      return fail(
        `fixture namespace ${this.namespace} names differ: artifact ${debugStrings(artifactNames)} rust ${debugStrings(ownedNames)}`,
      );
    }
    for (const name of ownedNames) {
      const owned = this.json.get(name)!;
      if (!fixtureJsonMatches(owned, expected[name]!, true)) {
        return fail(`fixture ${name} JSON diverged: artifact ${jsonString(expected[name]!)} rust ${jsonString(owned)}`);
      }
    }
    const vocabularyNames = new Set(artifact.vocabulary.expressionNames);
    for (const scenario of artifact.scenarios) {
      if (scenario.fixtureNamespace !== this.namespace) {
        continue;
      }
      if (scenarioIds.length === 0 || scenarioIds.includes(scenarioId(scenario))) {
        validateScenarioNames(scenario, this, vocabularyNames);
      }
    }
  }
}

/** Resolves fixture names before consulting the live snapshot. */
export function bindEvidence(fixtures: FixtureTable, snapshot: Evidence): Evidence {
  return {
    resolveName: name => fixtures.get(name) ?? snapshot.resolveName(name),
    resolveCall: (operator, args) => snapshot.resolveCall?.(operator, args),
  };
}

function setJsonEqual(left: readonly Json[], right: readonly Json[]): boolean {
  const sorted = (values: readonly Json[]): string[] => values.map(jsonString).sort(compareStrings);
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Compares owned JSON with the artifact's. Arrays match an artifact `#set`.
 * With `exact`, objects must have identical key sets; otherwise the owned
 * object's keys need only be a subset.
 */
function fixtureJsonMatches(owned: Json, artifact: Json, exact: boolean): boolean {
  if (jsonString(owned) === jsonString(artifact)) {
    return true;
  }
  if (Array.isArray(owned)) {
    if (isObject(artifact)) {
      const members = artifact["#set"];
      if (Array.isArray(members)) {
        return setJsonEqual(owned as readonly Json[], members as readonly Json[]);
      }
    }
    return false;
  }
  if (isObject(owned) && isObject(artifact)) {
    if (exact && Object.keys(owned).length !== Object.keys(artifact).length) {
      return false;
    }
    return Object.keys(owned).every(key => {
      const artifactValue = artifact[key];
      return artifactValue !== undefined && fixtureJsonMatches(owned[key]!, artifactValue, exact);
    });
  }
  return false;
}

/** Free names in a normalized expression: those not bound by an enclosing lambda or let. */
export function expressionNames(expression: Json | undefined, bound: ReadonlySet<string> = new Set()): string[] {
  switch (kindOf(expression)) {
    case "name": {
      const name = jsonField(expression, "value");
      return typeof name === "string" && !bound.has(name) ? [name] : [];
    }
    case "call": {
      const args = jsonField(expression, "arguments");
      return Array.isArray(args) ? (args as readonly Json[]).flatMap(argument => expressionNames(argument, bound)) : [];
    }
    case "lambda": {
      const nested = new Set(bound);
      const parameters = jsonField(expression, "parameters");
      if (Array.isArray(parameters)) {
        for (const parameter of parameters as readonly Json[]) {
          if (typeof parameter === "string") {
            nested.add(parameter);
          }
        }
      }
      const body = jsonField(expression, "body");
      return body === undefined ? [] : expressionNames(body, nested);
    }
    case "let": {
      const nested = new Set(bound);
      const name = jsonField(expression, "name");
      if (typeof name === "string") {
        nested.add(name);
      }
      const value = jsonField(expression, "value");
      const body = jsonField(expression, "body");
      return [
        ...(value === undefined ? [] : expressionNames(value, bound)),
        ...(body === undefined ? [] : expressionNames(body, nested)),
      ];
    }
    default:
      return [];
  }
}

function validateScenarioNames(scenario: ArtifactScenario, fixtures: FixtureTable, vocabularyNames: ReadonlySet<string>): void {
  for (const step of scenario.steps) {
    if (step.kind !== "action") {
      continue;
    }
    for (const assertion of [...step.guards, ...step.next]) {
      for (const name of expressionNames(assertion.expression)) {
        if (name === "state" || fixtures.containsName(name) || vocabularyNames.has(name)) {
          continue;
        }
        return fail(`${scenarioId(scenario)}:${step.action} names ${name} but neither fixtures nor snapshot state own it`);
      }
    }
  }
}
