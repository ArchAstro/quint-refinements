import { fail, messageOf, RefinementError } from "./error.js";
import { expressionVocabulary } from "./vocabulary.js";
import { isObject, type Json, type JsonObject, parseJson, sortedKeys } from "./json.js";

/**
 * The conformance artifact (schema v2 or v3) exported from the Quint model.
 *
 * Schema v3 stores each distinct list of obligations once in `assertionLists`
 * and a step names its `guardList` and `nextList` by index. Parsing resolves
 * those references, so every action step carries its own `guards` and `next`
 * whichever schema the file used.
 */
export interface ConformanceArtifact {
  /** The version of the generated artifact schema. */
  readonly schemaVersion: number;
  /** The digest of the Quint model inputs used during generation. */
  readonly modelDigest: string;
  /** The closed action, capability, expression and observation vocabulary. */
  readonly vocabulary: ArtifactVocabulary;
  /** Generated fixture values keyed by model namespace and fixture name. */
  readonly fixtures: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  /** The ordered scenarios generated from model runs. */
  readonly scenarios: readonly ArtifactScenario[];
}

/** The closed vocabulary published by the trace generator. */
export interface ArtifactVocabulary {
  readonly actions: readonly string[];
  readonly capabilities: readonly string[];
  readonly expressionOperators: readonly string[];
  readonly expressionNames: readonly string[];
  readonly refinementExpressionOperators: readonly string[];
  readonly runtimeObservationDependencies: readonly string[];
  readonly runtimeObservationDependencyDigest: string;
}

/** One ordered conformance scenario. */
export interface ArtifactScenario {
  readonly source: string;
  readonly module: string;
  readonly fixtureNamespace: string;
  readonly name: string;
  readonly requiredCapabilities: readonly string[];
  /**
   * The complete generated initial model state (ITF JSON), absent when full
   * refinement is not enabled for the scenario.
   */
  readonly initialState?: Json;
  readonly steps: readonly ArtifactStep[];
}

/** The stable scenario identifier used by the coverage report. */
export function scenarioId(scenario: Pick<ArtifactScenario, "module" | "name">): string {
  return `${scenario.module}.${scenario.name}`;
}

/** An initializer step that precedes all implementation actions. */
export interface InitStep {
  readonly kind: "init";
  readonly index: number;
  readonly action: string;
  readonly arguments: readonly Json[];
}

/** A model action owned by an implementation primitive. */
export interface ActionStep {
  readonly kind: "action";
  readonly index: number;
  readonly action: string;
  readonly arguments: readonly Json[];
  readonly guards: readonly ArtifactAssertion[];
  readonly next: readonly ArtifactAssertion[];
}

/** An observation-only step evaluated against the current snapshot. */
export interface ObserveStep {
  readonly kind: "observe";
  readonly index: number;
  readonly assertions: readonly ArtifactAssertion[];
}

export type ArtifactStep = InitStep | ActionStep | ObserveStep;

/** Whether an assertion is supplied by a runtime adapter or extracted from the model. */
export type AssertionScope = "runtime" | "model";

/** Assertion provenance and normalized dependencies. */
export interface ArtifactAssertion {
  readonly scope: AssertionScope;
  /** The normalized expression tree the evaluator interprets. */
  readonly expression: Json;
  readonly dependencies: readonly string[];
}

/** The action steps of a scenario, in order. */
export function actionSteps(scenario: ArtifactScenario): ActionStep[] {
  return scenario.steps.filter((step): step is ActionStep => step.kind === "action");
}

/**
 * A strict JSON object reader: required fields must exist and any field that is
 * not consumed is rejected, like serde's `deny_unknown_fields`.
 */
class StrictObject {
  private readonly consumed = new Set<string>();
  private readonly object: JsonObject;
  private readonly name: string;

  constructor(value: Json | undefined, name: string) {
    if (!isObject(value)) {
      throw new RefinementError(`${name} must be an object`);
    }
    this.object = value;
    this.name = name;
  }

  private raw(key: string, required: boolean): Json | undefined {
    this.consumed.add(key);
    const value = this.object[key];
    if (value === undefined && required) {
      throw new RefinementError(`missing field \`${key}\``);
    }
    return value;
  }

  private invalid(key: string, expected: string): never {
    throw new RefinementError(`invalid field \`${key}\`: expected ${expected}`);
  }

  string(key: string): string {
    const value = this.raw(key, true);
    return typeof value === "string" ? value : this.invalid(key, "a string");
  }

  /** An unsigned integer that fits a JavaScript number. */
  count(key: string): number {
    const value = this.raw(key, true);
    if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return this.invalid(key, "an unsigned integer");
  }

  /** A `u32`, which is how Rust and Go read `schemaVersion`. */
  version(key: string): number {
    const value = this.count(key);
    return value <= 0xffffffff ? value : this.invalid(key, "a 32-bit unsigned integer");
  }

  strings(key: string, required: boolean): readonly string[] {
    const value = this.raw(key, required);
    if (value === undefined) {
      return [];
    }
    if (Array.isArray(value) && (value as readonly Json[]).every(item => typeof item === "string")) {
      return value as readonly string[];
    }
    return this.invalid(key, "an array of strings");
  }

  array(key: string, required: boolean): readonly Json[] {
    const value = this.raw(key, required);
    if (value === undefined) {
      return [];
    }
    return Array.isArray(value) ? (value as readonly Json[]) : this.invalid(key, "an array");
  }

  json(key: string, required: boolean): Json | undefined {
    return this.raw(key, required);
  }

  finish(): void {
    for (const key of sortedKeys(this.object)) {
      if (!this.consumed.has(key)) {
        throw new RefinementError(`unknown field \`${key}\` in ${this.name}`);
      }
    }
  }
}

function decodeVocabulary(value: Json | undefined): ArtifactVocabulary {
  const reader = new StrictObject(value, "vocabulary");
  const decoded = {
    actions: reader.strings("actions", true),
    capabilities: reader.strings("capabilities", true),
    expressionOperators: reader.strings("expressionOperators", true),
    expressionNames: reader.strings("expressionNames", true),
    refinementExpressionOperators: reader.strings("refinementExpressionOperators", false),
    runtimeObservationDependencies: reader.strings("runtimeObservationDependencies", true),
    runtimeObservationDependencyDigest: reader.string("runtimeObservationDependencyDigest"),
  };
  reader.finish();
  return decoded;
}

function decodeAssertions(values: readonly Json[]): ArtifactAssertion[] {
  return values.map(value => {
    const reader = new StrictObject(value, "assertion");
    const scope = reader.string("scope");
    const expression = reader.json("expression", true) as Json;
    const dependencies = reader.strings("dependencies", false);
    reader.finish();
    if (scope !== "runtime" && scope !== "model") {
      return fail(`unknown variant \`${scope}\`, expected \`runtime\` or \`model\``);
    }
    return { scope, expression, dependencies };
  });
}

const firstSupportedSchema = 2;
const latestSchema = 3;

/** The schema-v3 `assertionLists` table, and the version that says how steps use it. */
interface SharedLists {
  readonly version: number;
  readonly lists: readonly (readonly ArtifactAssertion[])[];
}

function resolveList(shared: SharedLists, field: string, reference: Json): readonly ArtifactAssertion[] {
  if (typeof reference !== "bigint" || reference < 0n || reference >= BigInt(shared.lists.length)) {
    return fail(
      `\`${field}\` ${String(reference)} is out of range: the artifact has ${shared.lists.length} assertion lists`,
    );
  }
  return shared.lists[Number(reference)] as readonly ArtifactAssertion[];
}

function decodeStep(value: Json, shared: SharedLists, scenario: string): ArtifactStep {
  const reader = new StrictObject(value, "step");
  const kind = reader.string("kind");
  switch (kind) {
    case "init": {
      const step: InitStep = {
        kind,
        index: reader.count("index"),
        action: reader.string("action"),
        arguments: reader.array("arguments", true),
      };
      reader.finish();
      return step;
    }
    case "action": {
      const index = reader.count("index");
      const action = reader.string("action");
      const args = reader.array("arguments", true);
      const guards = reader.json("guards", false);
      const next = reader.json("next", false);
      const guardList = reader.json("guardList", false);
      const nextList = reader.json("nextList", false);
      reader.finish();
      const inline = guards !== undefined || next !== undefined;
      const referenced = guardList !== undefined || nextList !== undefined;
      if (shared.version >= 3 && inline) {
        return fail(
          `step ${index} of ${scenario} has inline \`guards\` or \`next\`; schema version ${shared.version} names them with \`guardList\` and \`nextList\``,
        );
      }
      if (shared.version < 3 && referenced) {
        return fail(
          `step ${index} of ${scenario} uses \`guardList\` or \`nextList\`, which need schema version 3, found ${shared.version}`,
        );
      }
      const resolve = (field: string, reference: Json | undefined, inlineValue: Json | undefined) => {
        if (reference !== undefined) {
          return resolveList(shared, field, reference);
        }
        if (inlineValue === undefined) {
          return [];
        }
        if (!Array.isArray(inlineValue)) {
          return fail(`invalid field \`${field === "guardList" ? "guards" : "next"}\`: expected an array`);
        }
        return decodeAssertions(inlineValue as readonly Json[]);
      };
      return {
        kind,
        index,
        action,
        arguments: args,
        guards: resolve("guardList", guardList, guards),
        next: resolve("nextList", nextList, next),
      };
    }
    case "observe": {
      const index = reader.count("index");
      const assertions = reader.array("assertions", true);
      reader.finish();
      return { kind, index, assertions: decodeAssertions(assertions) };
    }
    default:
      return fail(`unknown variant \`${kind}\`, expected one of \`init\`, \`action\`, \`observe\``);
  }
}

function decodeScenario(value: Json, shared: SharedLists): ArtifactScenario {
  const reader = new StrictObject(value, "scenario");
  const source = reader.string("source");
  const module = reader.string("module");
  const fixtureNamespace = reader.string("fixtureNamespace");
  const name = reader.string("name");
  const requiredCapabilities = reader.strings("requiredCapabilities", true);
  const initialState = reader.json("initialState", false);
  const steps = reader.array("steps", true);
  reader.finish();
  const scenario = { source, module, fixtureNamespace, name, requiredCapabilities, steps: steps.map(step => decodeStep(step, shared, `${module}.${name}`)) };
  return initialState === undefined || initialState === null ? scenario : { ...scenario, initialState };
}

function decodeFixtures(value: Json | undefined): Record<string, Record<string, Json>> {
  if (!isObject(value)) {
    return fail("invalid field `fixtures`: expected an object");
  }
  // No prototype: a fixture named `toString` or `__proto__` is an ordinary key.
  const fixtures = Object.create(null) as Record<string, Record<string, Json>>;
  for (const namespace of sortedKeys(value)) {
    const entries = value[namespace];
    if (!isObject(entries)) {
      return fail("invalid field `fixtures`: expected an object of objects");
    }
    fixtures[namespace] = Object.assign(Object.create(null) as Record<string, Json>, entries);
  }
  return fixtures;
}

function decodeArtifact(root: Json): ConformanceArtifact {
  const reader = new StrictObject(root, "artifact");
  const schemaVersion = reader.version("schemaVersion");
  const modelDigest = reader.string("modelDigest");
  const vocabularyValue = reader.json("vocabulary", true);
  const fixtures = decodeFixtures(reader.json("fixtures", true));
  const assertionLists = reader.json("assertionLists", false);
  const scenarios = reader.array("scenarios", true);
  reader.finish();
  if (schemaVersion < firstSupportedSchema || schemaVersion > latestSchema) {
    return fail(
      `unsupported schema version ${schemaVersion}; this runtime reads versions ${firstSupportedSchema} to ${latestSchema}`,
    );
  }
  if (assertionLists !== undefined && schemaVersion < 3) {
    return fail(`\`assertionLists\` needs schema version 3, found ${schemaVersion}`);
  }
  if (assertionLists !== undefined && !Array.isArray(assertionLists)) {
    return fail("invalid field `assertionLists`: expected an array");
  }
  const lists = ((assertionLists ?? []) as readonly Json[]).map(list => {
    if (!Array.isArray(list)) {
      return fail("invalid field `assertionLists`: expected an array of arrays");
    }
    return decodeAssertions(list as readonly Json[]);
  });
  const shared: SharedLists = { version: schemaVersion, lists };
  return {
    schemaVersion,
    modelDigest,
    vocabulary: decodeVocabulary(vocabularyValue),
    fixtures,
    scenarios: scenarios.map(scenario => decodeScenario(scenario, shared)),
  };
}

/**
 * Parses the checked JSON artifact without interpreting Quint source. Fails
 * closed on unknown fields, missing fields and a refinement vocabulary that
 * differs from this evaluator's.
 */
export function parseConformanceArtifact(source: string): ConformanceArtifact {
  let artifact: ConformanceArtifact;
  try {
    artifact = decodeArtifact(parseJson(source));
  } catch (error) {
    return fail(`invalid refinement artifact: ${messageOf(error)}`);
  }
  const complete = artifact.scenarios.some(scenario => scenario.initialState !== undefined);
  const operators = artifact.vocabulary.refinementExpressionOperators;
  if (
    complete &&
    (operators.length !== expressionVocabulary.length || operators.some((operator, index) => operator !== expressionVocabulary[index]))
  ) {
    return fail("artifact refinement expression vocabulary differs from the TypeScript evaluator");
  }
  return artifact;
}
