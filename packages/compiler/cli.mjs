#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  conformanceDirective,
  defineConformanceApp,
  generateConformanceTraces,
  observationDependencies,
  resolveQuintBinary,
} from "./generate.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(
  fs.readFileSync(path.resolve(packageRoot, "..", "..", "package.json"), "utf8"),
);

const rustKeywords = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
  "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
  "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
  "struct", "super", "trait", "true", "type", "union", "unsafe", "use", "where",
  "while", "abstract", "become", "box", "do", "final", "macro", "override", "priv",
  "typeof", "unsized", "virtual", "yield", "try",
]);

// Names the generated `Implementation` trait already uses.
const reservedHooks = new Set(["from_initial_state", "snapshot", "fixtures"]);

function fail(message) {
  throw new Error(message);
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: options.cwd,
  });
  if (result.error) {
    fail(`could not start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} exited with status ${result.status}`
      + `${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }
  return result;
}

function quintBinary() {
  return resolveQuintBinary(packageRoot);
}

function flattenThen(node) {
  if (node?.kind === "app" && node.opcode === "then") {
    return [...flattenThen(node.args[0]), node.args[1]];
  }
  return [node];
}

// `@primitive commit = [prepare, flushWal, commitPrepared]` in the module doc
// comment declares one implementation command that owns an ordered sequence of
// Quint actions. It is the only ownership fact the model cannot express itself.
function primitiveDirectives(doc, context) {
  const primitives = [];
  for (const line of (doc ?? "").split("\n").map(line => line.trim())) {
    if (!line.startsWith("@primitive")) {
      continue;
    }
    const match = line.match(
      /^@primitive ([A-Za-z][A-Za-z0-9_]*) = \[([A-Za-z][A-Za-z0-9_]*(?:, [A-Za-z][A-Za-z0-9_]*)*)\]$/,
    );
    if (!match) {
      fail(
        `${context} has a malformed @primitive directive; `
        + "write `@primitive name = [firstAction, secondAction]`",
      );
    }
    primitives.push({ name: match[1], actions: match[2].split(", ") });
  }
  return primitives;
}

function expressionPath(node) {
  if (node?.kind === "name") {
    return node.name;
  }
  if (
    node?.kind === "app"
    && node.opcode === "field"
    && node.args?.length === 2
    && node.args[1]?.kind === "str"
  ) {
    const base = expressionPath(node.args[0]);
    return base ? `${base}.${node.args[1].value}` : undefined;
  }
  return undefined;
}

function collectAstVocabulary(node, result, bound = new Set()) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.kind === "name") {
    if (!bound.has(node.name)) {
      result.names.add(node.name);
      result.retrieve.add(`name:${node.name}`);
    }
    return;
  }
  if (node.kind === "app") {
    result.operators.add(node.opcode);
    result.retrieve.add(`operator:${node.opcode}`);
    const expression = expressionPath(node);
    if (node.opcode === "field" && expression) {
      result.paths.add(expression);
      result.retrieve.add(`path:${expression}`);
    }
    (node.args ?? []).forEach(argument => collectAstVocabulary(argument, result, bound));
    return;
  }
  if (node.kind === "lambda") {
    const nested = new Set(bound);
    (node.params ?? []).forEach(parameter => nested.add(parameter.name));
    collectAstVocabulary(node.expr, result, nested);
    return;
  }
  if (node.kind === "let") {
    collectAstVocabulary(node.opdef?.expr, result, bound);
    const nested = new Set(bound);
    if (node.opdef?.name) {
      nested.add(node.opdef.name);
    }
    collectAstVocabulary(node.expr, result, nested);
  }
}

function collectObservationVocabulary(node, result) {
  if (node?.kind !== "app" || node.opcode !== "actionAll") {
    return;
  }
  for (const member of node.args ?? []) {
    if (member?.kind === "app" && member.opcode === "assert") {
      collectAstVocabulary(member.args?.[0], result);
    }
  }
}

function parseQuint(sourcePath) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-parse-"));
  const outputPath = path.join(temporaryDirectory, "parsed.json");
  try {
    // Quint reports model errors in the output file and exits non-zero.
    const result = spawnSync(quintBinary(), ["parse", sourcePath, `--out=${outputPath}`], {
      cwd: path.dirname(sourcePath),
      encoding: "utf8",
    });
    if (result.error) {
      fail(`could not start Quint: ${result.error.message}`);
    }
    if (!fs.existsSync(outputPath)) {
      fail(`Quint could not parse ${sourcePath}:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if ((parsed.errors ?? []).length > 0) {
      fail(`Quint rejected the model:\n${parsed.errors.map(error => {
        const location = error.locs?.[0];
        const where = location
          ? `${path.relative(path.dirname(sourcePath), location.source)}:${location.start.line + 1}:${location.start.col + 1}: `
          : "";
        return `  ${where}${error.explanation ?? JSON.stringify(error)}`;
      }).join("\n")}`);
    }
    return parsed;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function inferProject(parsed, sourceName, requestedModule, targets = { rust: true, go: false, typescript: false }) {
  const candidates = (parsed.modules ?? []).filter(module =>
    module.declarations.some(declaration =>
      declaration.kind === "def"
      && declaration.qualifier === "run"
      && (declaration.doc ?? "").includes("@conformance")
    )
  );
  const module = requestedModule
    ? candidates.find(candidate => candidate.name === requestedModule)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!module) {
    const names = candidates.map(candidate => candidate.name).join(", ") || "none";
    fail(
      requestedModule
        ? `module ${requestedModule} has no conformance runs; candidates: ${names}`
        : `expected one module with conformance runs, found ${candidates.length}: ${names}`,
    );
  }

  const runs = module.declarations.filter(declaration =>
    declaration.kind === "def"
    && declaration.qualifier === "run"
    && (declaration.doc ?? "").includes("@conformance")
  );
  const initializers = new Set();
  const actions = new Set();
  const capabilities = new Set();
  const vocabulary = {
    names: new Set(),
    operators: new Set(),
    paths: new Set(),
    retrieve: new Set(),
  };

  for (const runDeclaration of runs) {
    const directive = conformanceDirective(
      runDeclaration.doc,
      `${sourceName}:${module.name}.${runDeclaration.name}`,
    );
    directive.capabilities.forEach(capability => capabilities.add(capability));
    const runActions = [];
    const nodes = flattenThen(runDeclaration.expr);
    const initializer = nodes.shift();
    if (initializer?.kind !== "name") {
      fail(`${runDeclaration.name} must begin with a named initializer`);
    }
    initializers.add(initializer.name);
    for (const node of nodes) {
      if (node?.kind === "app" && node.opcode === "actionAll") {
        collectObservationVocabulary(node, vocabulary);
      } else if (node?.kind === "name") {
        runActions.push(node.name);
      } else if (node?.kind === "app") {
        runActions.push(node.opcode);
        // Arguments may name model constants, such as `pay(orderA)`.
        (node.args ?? []).forEach(argument => collectAstVocabulary(argument, vocabulary));
      } else {
        fail(`${runDeclaration.name} contains an unsupported ${node?.kind ?? "unknown"} step`);
      }
    }
    for (const action of runActions) {
      actions.add(action);
      if (directive.derived) {
        capabilities.add(`${module.name}.${action}`);
      }
    }
  }
  if (initializers.size !== 1) {
    fail(`conformance runs must share one initializer; found ${[...initializers].join(", ")}`);
  }
  if (actions.size === 0) {
    fail("conformance runs contain no implementation actions");
  }

  // The scenario module wins; actions it imports resolve from the other
  // modules Quint parsed alongside it.
  const actionDefinitions = new Map(
    [...(parsed.modules ?? []).filter(candidate => candidate !== module), module]
      .flatMap(candidate => candidate.declarations)
      .filter(declaration => declaration.kind === "def" && declaration.qualifier === "action")
      .map(declaration => [declaration.name, declaration]),
  );
  for (const action of actions) {
    const definition = actionDefinitions.get(action);
    if (!definition) {
      fail(`conformance action ${action} has no action definition reachable from ${module.name}`);
    }
    collectAstVocabulary(definition.expr, vocabulary);
  }
  const declarations = (parsed.modules ?? []).flatMap(candidate => candidate.declarations);
  for (const declaration of declarations) {
    if (declaration.kind === "def" && declaration.qualifier !== "run") {
      collectAstVocabulary(declaration.expr, vocabulary);
    }
  }

  const stateVariables = [...new Set(
    declarations
      .filter(declaration => declaration.kind === "var")
      .map(declaration => declaration.name),
  )].sort();
  if (stateVariables.length !== 1 || stateVariables[0] !== "state") {
    fail(
      `${sourceName} declares state variables [${stateVariables.join(", ")}]; `
      + "keep the whole model state in one `var state` (use a record for several fields) "
      + "so each implementation snapshot can be compared with it",
    );
  }
  const stateVariable = declarations.find(declaration => declaration.kind === "var");
  const aliases = new Map(
    declarations
      .filter(declaration => declaration.kind === "typedef" && declaration.type)
      .map(declaration => [declaration.name, declaration.type]),
  );
  let stateType = stateVariable.typeAnnotation;
  while (stateType?.kind === "const" && aliases.has(stateType.name)) {
    stateType = aliases.get(stateType.name);
  }
  if (stateType && stateType.kind !== "rec") {
    fail(
      `${sourceName} declares \`var state\` as a ${stateType.kind}; `
      + "make it a record, for example `var state: { count: int }`, "
      + "so obligations can name the fields they read",
    );
  }
  stateVariables.forEach(name => {
    vocabulary.names.add(name);
    vocabulary.retrieve.add(`name:${name}`);
  });

  const initializer = [...initializers][0];
  const sortedActions = [...actions].sort();
  const compound = primitiveDirectives(module.doc, `${sourceName}:${module.name}`);
  const owned = new Map();
  for (const primitive of compound) {
    for (const action of primitive.actions) {
      if (!actions.has(action)) {
        fail(`@primitive ${primitive.name} owns ${action}, which no conformance run executes`);
      }
      if (owned.has(action)) {
        fail(`${action} is owned by both @primitive ${owned.get(action)} and ${primitive.name}`);
      }
      owned.set(action, primitive.name);
    }
  }
  const primitives = [
    ...compound.map(primitive => ({ ...primitive, compound: true })),
    ...sortedActions
      .filter(action => !owned.has(action))
      .map(action => ({ name: action, actions: [action], compound: false })),
  ].sort((left, right) => left.name.localeCompare(right.name));
  if (targets.rust) {
    const rustPrimitives = new Map();
    for (const primitive of primitives) {
      const identifier = rustIdentifier(primitive.name);
      if (rustKeywords.has(identifier) || reservedHooks.has(identifier)) {
        fail(`${primitive.name} maps to reserved Rust name ${identifier}; rename it or wrap it in a @primitive`);
      }
      const existing = rustPrimitives.get(identifier);
      if (existing) {
        fail(`${existing} and ${primitive.name} both map to Rust identifier ${identifier}`);
      }
      rustPrimitives.set(identifier, primitive.name);
    }
  }
  if (targets.go) {
    checkGoNames(primitives);
  }
  if (targets.typescript) {
    checkTypescriptNames(primitives);
  }
  const observationOperators = [...vocabulary.operators]
    .filter(operator => !["assert", "assign"].includes(operator))
    .sort();

  // Fixture values can mention constructors from any module the model imports,
  // so the generator needs every one of them in scope to read the values back.
  const sourceStem = path.basename(sourceName, ".qnt");
  const fixtureImports = new Map();
  for (const candidate of parsed.modules ?? []) {
    for (const declaration of candidate.declarations) {
      if (declaration.kind !== "import" || declaration.protoName === module.name) {
        continue;
      }
      fixtureImports.set(declaration.protoName, {
        module: declaration.protoName,
        source: declaration.fromSource
          ? declaration.fromSource.replace(/^\.\//, "").replace(/\.qnt$/, "")
          : sourceStem,
      });
    }
  }

  return {
    source: sourceName,
    module: module.name,
    fixtureImports: [...fixtureImports.values()],
    initializer,
    step: sortedActions[0],
    actions: sortedActions,
    primitives,
    capabilities: [...capabilities].sort(),
    runs: runs.map(run => run.name).sort(),
    fullyRefinedRuns: new Set(runs.map(run => `${module.name}.${run.name}`)),
    expressionNames: [...vocabulary.names].sort(),
    expressionOperators: observationOperators,
    retrieve: [...vocabulary.retrieve].sort(),
    paths: [...vocabulary.paths].sort(),
    stateVariables,
  };
}

function rustIdentifier(name) {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1")
    .toLowerCase();
  return snake || "action";
}

function rustConstant(name) {
  return rustIdentifier(name).toUpperCase();
}

function rustString(value) {
  return JSON.stringify(value);
}

function primitiveId(project, primitive) {
  return `${project.module}.${primitive.name}`;
}

function quoted(names) {
  return names.map(name => `\`${name}\``).join(", ");
}

export function generateRustModule(project) {
  const observations = project.paths.map(rustString).join(", ");
  const retrieveNames = project.stateVariables.map(name => rustString(`name:${name}`)).join(", ");
  const ownershipConstants = project.primitives.map(primitive => `quint_ownership! {
    const ${rustConstant(primitive.name)} = {
        primitive: ${rustString(primitiveId(project, primitive))},
        refines: [${primitive.actions.map(rustString).join(", ")}],
        aliases: [],
        observations: [${observations}],
        retrieve: [${retrieveNames}],
    };
}`).join("\n\n");
  const descriptors = project.primitives.map(primitive => rustConstant(primitive.name)).join(", ");
  const retrieve = project.retrieve.map(value => `    ${rustString(value)},`).join("\n");
  const traitMethods = project.primitives.map(primitive => primitive.compound
    ? `    /// Execute Quint actions ${quoted(primitive.actions)} as one command.
    ///
    /// Return one snapshot taken after each action, in that order.
    fn ${rustIdentifier(primitive.name)}(
        &mut self,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String>;`
    : `    /// Execute Quint action \`${primitive.name}\` with its generated arguments.
    fn ${rustIdentifier(primitive.name)}(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;`
  ).join("\n\n");
  const matchArms = project.primitives.map(primitive => primitive.compound
    ? `            ${rustString(primitiveId(project, primitive))} => {
                let expected = [${primitive.actions.map(rustString).join(", ")}];
                if actions.iter().map(|action| action.name.as_str()).ne(expected) {
                    return Err(format!("${primitive.name} refines {expected:?}; got {actions:?}"));
                }
                self.implementation.${rustIdentifier(primitive.name)}(actions)
            }`
    : `            ${rustString(primitiveId(project, primitive))} => {
                let [action] = actions else {
                    return Err(format!("${primitive.name} expects one Quint action; got {actions:?}"));
                };
                if action.name != ${rustString(primitive.name)} {
                    return Err(format!("${primitive.name} primitive cannot refine {}", action.name));
                }
                self.implementation.${rustIdentifier(primitive.name)}(&action.arguments)?;
                Ok(vec![self.implementation.snapshot()])
            }`
  ).join("\n");

  return `// @generated by quint-refinements from ${project.source}. Do not edit.
// Regenerate with \`quint-refinements compile\`.
#![allow(dead_code)]

use quint_refinements::{
    AsyncPrimitiveDriver, ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence,
    OwnershipTable, PrimitiveDriver, ResolvedAction, RuntimeValue, collect_ownership_records,
    quint_ownership, refine_scenario,
};

const TRACES: &str = include_str!(${rustString(project.artifactInclude)});

${ownershipConstants}

/// Which implementation command owns each Quint action.
pub const OWNERSHIP: OwnershipTable = OwnershipTable {
    owner: ${rustString(`${project.module}-generated-refinement`)},
    descriptors: &[${descriptors}],
};

/// Everything the generated obligations may read from a snapshot.
pub const RETRIEVE: &[&str] = &[
${retrieve}
];

/// Domain implementation connected to the generated Quint scenarios.
pub trait Implementation: Sized {
    /// Snapshot type exposed to the refinement evaluator.
    type Evidence: NormalizedRuntimeEvidence + Clone;

    /// Construct the implementation from a scenario's generated initial state.
    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String>;

    /// Return the current observable implementation state.
    fn snapshot(&self) -> Self::Evidence;

    /// Values for the constants the model names, such as \`pure val limit = 3\`.
    ///
    /// By default each constant has the value the model gives it. Override
    /// this to bind a constant to a production value instead; the runner then
    /// fails if that value and the model disagree.
    fn fixtures(artifact: &ConformanceArtifact) -> Result<FixtureTable, String> {
        FixtureTable::from_artifact(${rustString(project.module)}, artifact)
            .map_err(|error| error.to_string())
    }

${traitMethods}
}

/// Result of refining one generated Quint run.
pub struct ScenarioResult<I> {
    /// Fully qualified generated scenario name.
    pub scenario: String,
    /// Number of evaluated guard and next-state obligations.
    pub evaluated_obligations: usize,
    /// Implementation state after the scenario completed.
    pub implementation: I,
}

/// Dispatches each owned Quint action sequence to its implementation hook.
pub struct Driver<I> {
    /// The implementation under refinement.
    pub implementation: I,
}

impl<I: Implementation> PrimitiveDriver for Driver<I> {
    type Evidence = I::Evidence;

    fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String> {
        match primitive {
${matchArms}
            other => Err(format!("unknown generated primitive {other}")),
        }
    }
}

impl<I> AsyncPrimitiveDriver for Driver<I>
where
    I: Implementation + Send,
    I::Evidence: Send,
{
    type Evidence = I::Evidence;

    async fn run_primitive(
        &mut self,
        primitive: &str,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String> {
        PrimitiveDriver::run_primitive(self, primitive, actions)
    }
}

/// Parse the generated scenarios this module was compiled with.
pub fn artifact() -> Result<ConformanceArtifact, String> {
    ConformanceArtifact::parse(TRACES).map_err(|error| error.to_string())
}

/// Run every generated conformance scenario against a fresh implementation.
pub fn refine_all<I: Implementation>() -> Result<Vec<ScenarioResult<I>>, String> {
    let artifact = artifact()?;
    let ownership = collect_ownership_records(&[OWNERSHIP]).map_err(|error| error.to_string())?;
    let fixtures = I::fixtures(&artifact)?;
    fixtures
        .validate(&artifact)
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();

    for scenario in &artifact.scenarios {
        let initial_json = scenario
            .initial_state
            .as_ref()
            .ok_or_else(|| format!("{} has no generated initial state", scenario.id()))?;
        let initial_state = RuntimeValue::from_itf_json(initial_json)?;
        let implementation = I::from_initial_state(&initial_state)?;
        let initial_evidence = implementation.snapshot();
        let mut driver = Driver { implementation };
        let evaluated_obligations = refine_scenario(
            scenario,
            initial_evidence,
            &ownership,
            RETRIEVE,
            &fixtures,
            &mut driver,
        )?;
        results.push(ScenarioResult {
            scenario: scenario.id(),
            evaluated_obligations,
            implementation: driver.implementation,
        });
    }

    Ok(results)
}
`;
}

const goModulePath = "github.com/ArchAstro/quint-refinements/bindings/go";

const goKeywords = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map",
  "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

// Names the generated Go `Implementation` interface already uses.
const goReservedMethods = new Set(["Snapshot"]);

// `commit_prepared` and `commitPrepared` both become `CommitPrepared`.
export function goMethodName(name) {
  const parts = rustIdentifier(name).split("_").filter(Boolean);
  const pascal = parts.map(part => part[0].toUpperCase() + part.slice(1)).join("");
  return /^[A-Z]/.test(pascal) ? pascal : `Action${pascal}`;
}

export function goPackageName(goPath, requested) {
  if (requested !== undefined) {
    if (!/^[a-z_][a-z0-9_]*$/.test(requested) || goKeywords.has(requested)) {
      fail(`--go-package ${requested} is not a valid Go package name`);
    }
    return requested;
  }
  const directory = path.basename(path.dirname(path.resolve(goPath)));
  const candidate = directory.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return /^[a-z_]/.test(candidate) && !goKeywords.has(candidate) ? candidate : "adapter";
}

function goStrings(values) {
  return `[]string{${values.map(rustString).join(", ")}}`;
}

function checkGoNames(primitives) {
  const methods = new Map();
  for (const primitive of primitives) {
    const method = goMethodName(primitive.name);
    if (goReservedMethods.has(method)) {
      fail(`${primitive.name} maps to reserved Go method ${method}; rename it or wrap it in a @primitive`);
    }
    if (methods.has(method)) {
      fail(`${methods.get(method)} and ${primitive.name} both map to Go method ${method}`);
    }
    methods.set(method, primitive.name);
  }
}

export function generateGoModule(project, packageName) {
  checkGoNames(project.primitives);
  if (project.artifactInclude.startsWith("..") || path.isAbsolute(project.artifactInclude)) {
    fail(
      `the Go adapter embeds ${project.artifactInclude}, but go:embed cannot reach outside the package directory; `
      + "pass --artifact with a path inside the --go file's directory",
    );
  }
  const observations = goStrings(project.paths);
  const retrieveNames = goStrings(project.stateVariables.map(name => `name:${name}`));
  const records = project.primitives.map(primitive => `{
			Primitive:    ${rustString(primitiveId(project, primitive))},
			Refines:      ${goStrings(primitive.actions)},
			Observations: ${observations},
			Retrieve:     ${retrieveNames},
		},`).join("\n\t\t");
  const retrieve = project.retrieve.map(value => `\t${rustString(value)},`).join("\n");
  const interfaceMethods = project.primitives.map(primitive => {
    const method = goMethodName(primitive.name);
    return primitive.compound
      ? `\t// ${method} executes Quint actions ${quoted(primitive.actions)} as one command.
\t//
\t// Return one snapshot taken after each action, in that order.
\t${method}(actions []refinements.ResolvedAction) ([]refinements.Evidence, error)`
      : `\t// ${method} executes Quint action \`${primitive.name}\` with its generated arguments.
\t${method}(arguments []refinements.RuntimeValue) error`;
  }).join("\n\n");
  const cases = project.primitives.map(primitive => {
    const method = goMethodName(primitive.name);
    return primitive.compound
      ? `\tcase ${rustString(primitiveId(project, primitive))}:
\t\texpected := ${goStrings(primitive.actions)}
\t\tif !slices.EqualFunc(actions, expected, func(action refinements.ResolvedAction, name string) bool { return action.Name == name }) {
\t\t\treturn nil, fmt.Errorf("${primitive.name} refines %s; got %s", refinements.FormatStrings(expected), refinements.FormatActions(actions))
\t\t}
\t\treturn d.Implementation.${method}(actions)`
      : `\tcase ${rustString(primitiveId(project, primitive))}:
\t\tif len(actions) != 1 {
\t\t\treturn nil, fmt.Errorf("${primitive.name} expects one Quint action; got %s", refinements.FormatActions(actions))
\t\t}
\t\tif actions[0].Name != ${rustString(primitive.name)} {
\t\t\treturn nil, fmt.Errorf("${primitive.name} primitive cannot refine %s", actions[0].Name)
\t\t}
\t\tif err := d.Implementation.${method}(actions[0].Arguments); err != nil {
\t\t\treturn nil, err
\t\t}
\t\treturn []refinements.Evidence{d.Implementation.Snapshot()}, nil`;
  }).join("\n");

  return `// Code generated by quint-refinements from ${project.source}. DO NOT EDIT.
// Regenerate with \`quint-refinements compile\`.

package ${packageName}

import (
	_ "embed"
	"fmt"${project.primitives.some(primitive => primitive.compound) ? '\n\t"slices"' : ""}

	refinements ${rustString(goModulePath)}
)

//go:embed ${project.artifactInclude}
var traces []byte

// Ownership says which implementation command owns each Quint action.
var Ownership = refinements.OwnershipTable{
	Owner: ${rustString(`${project.module}-generated-refinement`)},
	Descriptors: []refinements.OwnershipRecord{
		${records}
	},
}

// Retrieve is everything the generated obligations may read from a snapshot.
var Retrieve = []string{
${retrieve}
}

// Implementation is the domain implementation connected to the generated Quint
// scenarios. Snapshot must return a value that no later action changes.
type Implementation interface {
	// Snapshot returns the current observable implementation state.
	Snapshot() refinements.Evidence

${interfaceMethods}
}

// Option customizes RefineAll.
type Option func(*settings)

type settings struct {
	fixtures func(*refinements.ConformanceArtifact) (*refinements.FixtureTable, error)
}

// WithFixtures supplies the values for the constants the model names, such as
// \`pure val limit = 3\`.
//
// By default each constant has the value the model gives it. Use this to bind a
// constant to a production value instead; the runner then fails if that value
// and the model disagree.
func WithFixtures(fixtures func(*refinements.ConformanceArtifact) (*refinements.FixtureTable, error)) Option {
	return func(s *settings) { s.fixtures = fixtures }
}

// ScenarioResult is the result of refining one generated Quint run.
type ScenarioResult[I Implementation] struct {
	// Scenario is the fully qualified generated scenario name.
	Scenario string
	// EvaluatedObligations is the number of evaluated guard and next-state obligations.
	EvaluatedObligations int
	// Implementation is the implementation state after the scenario completed.
	Implementation I
}

// Driver dispatches each owned Quint action sequence to its implementation hook.
type Driver[I Implementation] struct {
	// Implementation is the implementation under refinement.
	Implementation I
}

// RunPrimitive implements refinements.PrimitiveDriver.
func (d *Driver[I]) RunPrimitive(primitive string, actions []refinements.ResolvedAction) ([]refinements.Evidence, error) {
	switch primitive {
${cases}
	default:
		return nil, fmt.Errorf("unknown generated primitive %s", primitive)
	}
}

// Artifact parses the generated scenarios this package was compiled with.
func Artifact() (*refinements.ConformanceArtifact, error) {
	return refinements.ParseConformanceArtifact(traces)
}

// RefineAll runs every generated conformance scenario against a fresh
// implementation built by newImplementation from the scenario's initial state.
func RefineAll[I Implementation](
	newImplementation func(initialState refinements.RuntimeValue) (I, error),
	options ...Option,
) ([]ScenarioResult[I], error) {
	var configured settings
	for _, option := range options {
		option(&configured)
	}
	artifact, err := Artifact()
	if err != nil {
		return nil, err
	}
	ownership, err := refinements.CollectOwnershipRecords(Ownership)
	if err != nil {
		return nil, err
	}
	var fixtures *refinements.FixtureTable
	if configured.fixtures != nil {
		fixtures, err = configured.fixtures(artifact)
	} else {
		fixtures, err = refinements.FixtureTableFromArtifact(${rustString(project.module)}, artifact)
	}
	if err != nil {
		return nil, err
	}
	if err := fixtures.Validate(artifact); err != nil {
		return nil, err
	}
	var results []ScenarioResult[I]
	for i := range artifact.Scenarios {
		scenario := &artifact.Scenarios[i]
		if scenario.InitialState == nil {
			return nil, fmt.Errorf("%s has no generated initial state", scenario.ID())
		}
		initialState, err := refinements.FromITFJSON(scenario.InitialState)
		if err != nil {
			return nil, err
		}
		implementation, err := newImplementation(initialState)
		if err != nil {
			return nil, err
		}
		driver := &Driver[I]{Implementation: implementation}
		evaluated, err := refinements.RefineScenario(scenario, implementation.Snapshot(), ownership, Retrieve, fixtures, driver)
		if err != nil {
			return nil, err
		}
		results = append(results, ScenarioResult[I]{
			Scenario:             scenario.ID(),
			EvaluatedObligations: evaluated,
			Implementation:       driver.Implementation,
		})
	}
	return results, nil
}
`;
}

const typescriptRuntimeModule = "quint-refinements/runtime";

// Names the generated TypeScript `Implementation` interface already uses, plus
// names that change what an object means: a `then` method makes an
// implementation look like a promise, `constructor` and `__proto__` are
// special on every object.
const typescriptReservedMethods = new Set([
  "snapshot", "then", "constructor", "__proto__", "toString", "toLocaleString",
  "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
]);

// `commit_prepared` and `commitPrepared` both become `commitPrepared`.
export function typescriptMethodName(name) {
  const [first = "", ...rest] = rustIdentifier(name).split("_").filter(Boolean);
  const camel = first + rest.map(part => part[0].toUpperCase() + part.slice(1)).join("");
  return /^[a-z]/.test(camel) ? camel : `action${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
}

function checkTypescriptNames(primitives) {
  const methods = new Map();
  for (const primitive of primitives) {
    const method = typescriptMethodName(primitive.name);
    if (typescriptReservedMethods.has(method)) {
      fail(`${primitive.name} maps to reserved TypeScript method ${method}; rename it or wrap it in a @primitive`);
    }
    if (methods.has(method)) {
      fail(`${methods.get(method)} and ${primitive.name} both map to TypeScript method ${method}`);
    }
    methods.set(method, primitive.name);
  }
}

function typescriptStrings(values) {
  return `[${values.map(rustString).join(", ")}]`;
}

export function generateTypeScriptModule(project) {
  checkTypescriptNames(project.primitives);
  const hasCompound = project.primitives.some(primitive => primitive.compound);
  const hasSingle = project.primitives.some(primitive => !primitive.compound);
  const observations = typescriptStrings(project.paths);
  const retrieveNames = typescriptStrings(project.stateVariables.map(name => `name:${name}`));
  const records = project.primitives.map(primitive => `    {
      primitive: ${rustString(primitiveId(project, primitive))},
      refines: ${typescriptStrings(primitive.actions)},
      observations: ${observations},
      retrieve: ${retrieveNames},
    },`).join("\n");
  const retrieve = project.retrieve.map(value => `  ${rustString(value)},`).join("\n");
  const interfaceMethods = project.primitives.map(primitive => {
    const method = typescriptMethodName(primitive.name);
    return primitive.compound
      ? `  /**
   * Executes Quint actions ${quoted(primitive.actions)} as one command.
   *
   * Return one snapshot taken after each action, in that order.
   */
  ${method}(actions: readonly ResolvedAction[]): readonly Evidence[];`
      : `  /** Executes Quint action \`${primitive.name}\` with its generated arguments. */
  ${method}(args: readonly RuntimeValue[]): void;`;
  }).join("\n\n");
  // Dispatches one primitive. The synchronous driver rejects a promise from
  // any method, because an unawaited promise would let the snapshot run first.
  const cases = awaited => project.primitives.map(primitive => {
    const method = typescriptMethodName(primitive.name);
    const call = args => `implementation.${method}(${args})`;
    const settle = (name, expression) => awaited ? `await ${expression}` : `ensureSynchronous(${rustString(name)}, ${expression})`;
    return primitive.compound
      ? `      case ${rustString(primitiveId(project, primitive))}:
        expectActions(${rustString(primitive.name)}, actions, ${typescriptStrings(primitive.actions)});
        return ${settle(method, call("actions"))};`
      : `      case ${rustString(primitiveId(project, primitive))}:
        ${settle(method, call(`expectOne(${rustString(primitive.name)}, actions).arguments`))};
        return [${settle("snapshot", "implementation.snapshot()")}];`;
  }).join("\n");
  const helpers = [
    hasCompound && `function expectActions(primitive: string, actions: readonly ResolvedAction[], expected: readonly string[]): void {
  if (actions.length !== expected.length || actions.some((action, index) => action.name !== expected[index])) {
    throw new RefinementError(\`\${primitive} refines \${formatStrings(expected)}; got \${formatActions(actions)}\`);
  }
}`,
    hasSingle && `function expectOne(action: string, actions: readonly ResolvedAction[]): ResolvedAction {
  const [only] = actions;
  if (only === undefined || actions.length !== 1) {
    throw new RefinementError(\`\${action} expects one Quint action; got \${formatActions(actions)}\`);
  }
  if (only.name !== action) {
    throw new RefinementError(\`\${action} primitive cannot refine \${only.name}\`);
  }
  return only;
}`,
  ].filter(Boolean).join("\n\n");
  const imports = [
    "FixtureTable",
    "RefinementError",
    "collectOwnershipRecords",
    "ensureSynchronous",
    "formatActions",
    hasCompound && "formatStrings",
    "fromItfJson",
    "parseConformanceArtifact",
    "refineScenario",
    "refineScenarioAsync",
    "scenarioId",
    "type ArtifactScenario",
    "type AsyncPrimitiveDriver",
    "type ConformanceArtifact",
    "type Evidence",
    "type MaybeAsync",
    "type OwnershipTable",
    "type PrimitiveDriver",
    "type ResolvedAction",
    "type RuntimeValue",
  ].filter(Boolean).map(name => `  ${name},`).join("\n");

  return `// @generated by quint-refinements from ${project.source}. Do not edit.
// Regenerate with \`quint-refinements compile\`.

import { readFileSync } from "node:fs";

import {
${imports}
} from ${rustString(typescriptRuntimeModule)};

/** Which implementation command owns each Quint action. */
export const ownership: OwnershipTable = {
  owner: ${rustString(`${project.module}-generated-refinement`)},
  descriptors: [
${records}
  ],
};

/** Everything the generated obligations may read from a snapshot. */
export const retrieve: readonly string[] = [
${retrieve}
];

/**
 * The domain implementation connected to the generated Quint scenarios.
 * \`snapshot()\` must return a value that no later action changes.
 *
 * Use \`MaybeAsync<Implementation>\` (and \`refineAll\`) when a method needs to
 * return a promise.
 */
export interface Implementation {
  /** Returns the current observable implementation state. */
  snapshot(): Evidence;

${interfaceMethods}
}

/** Options for {@link refineAll} and {@link refineAllSync}. */
export interface RefineOptions {
  /**
   * Supplies the values for the constants the model names, such as
   * \`pure val limit = 3\`.
   *
   * By default each constant has the value the model gives it. Use this to bind
   * a constant to a production value instead; the runner then fails if that
   * value and the model disagree.
   */
  readonly fixtures?: (artifact: ConformanceArtifact) => FixtureTable;
  /**
   * The parsed artifact to run. By default it is read from
   * ${project.artifactInclude} (relative to this file); pass it when a bundler or a
   * build step moves this file away from the artifact.
   */
  readonly artifact?: ConformanceArtifact;
}

/** The result of refining one generated Quint run. */
export interface ScenarioResult<I> {
  /** The fully qualified generated scenario name. */
  readonly scenario: string;
  /** The number of evaluated guard and next-state obligations. */
  readonly evaluatedObligations: number;
  /** The implementation state after the scenario completed. */
  readonly implementation: I;
}

${helpers}

/** Dispatches each owned Quint action sequence to its implementation method. */
export function driver(implementation: Implementation): PrimitiveDriver {
  return {
    runPrimitive(primitive, actions) {
      switch (primitive) {
${cases(false).replace(/^/gm, "  ")}
        default:
          throw new RefinementError(\`unknown generated primitive \${primitive}\`);
      }
    },
  };
}

/** Like {@link driver}, for an implementation whose methods return promises. */
export function asyncDriver(implementation: MaybeAsync<Implementation>): AsyncPrimitiveDriver {
  return {
    async runPrimitive(primitive, actions) {
      switch (primitive) {
${cases(true).replace(/^/gm, "  ")}
        default:
          throw new RefinementError(\`unknown generated primitive \${primitive}\`);
      }
    },
  };
}

/** Parses the generated scenarios this module was compiled with. */
export function artifact(): ConformanceArtifact {
  return parseConformanceArtifact(readFileSync(new URL(${rustString(project.artifactInclude.split("/").map(encodeURIComponent).join("/"))}, import.meta.url), "utf8"));
}

function prepare(options: RefineOptions): { scenarios: readonly ArtifactScenario[]; fixtures: FixtureTable } {
  const parsed = options.artifact ?? artifact();
  const fixtures = options.fixtures?.(parsed) ?? FixtureTable.fromArtifact(${rustString(project.module)}, parsed);
  fixtures.validate(parsed);
  return { scenarios: parsed.scenarios, fixtures };
}

const ownershipRecords = collectOwnershipRecords(ownership);

function initialStateOf(scenario: ArtifactScenario): RuntimeValue {
  if (scenario.initialState === undefined) {
    throw new RefinementError(\`\${scenarioId(scenario)} has no generated initial state\`);
  }
  return fromItfJson(scenario.initialState);
}

/**
 * Runs every generated conformance scenario against a fresh implementation
 * that \`newImplementation\` builds from the scenario's initial state. It
 * throws a \`RefinementError\` naming the first divergence.
 */
export function refineAllSync<I extends Implementation>(
  newImplementation: (initialState: RuntimeValue) => I,
  options: RefineOptions = {},
): ScenarioResult<I>[] {
  const { scenarios, fixtures } = prepare(options);
  return scenarios.map(scenario => {
    const implementation = newImplementation(initialStateOf(scenario));
    const evaluatedObligations = refineScenario(
      scenario,
      ensureSynchronous("snapshot", implementation.snapshot()),
      ownershipRecords,
      retrieve,
      fixtures,
      driver(implementation),
    );
    return { scenario: scenarioId(scenario), evaluatedObligations, implementation };
  });
}

/**
 * Like {@link refineAllSync}, for implementations whose methods may return
 * promises. A synchronous implementation works too. Scenarios run one after
 * another, and so do the primitives within each.
 */
export async function refineAll<I extends MaybeAsync<Implementation>>(
  newImplementation: (initialState: RuntimeValue) => I | Promise<I>,
  options: RefineOptions = {},
): Promise<ScenarioResult<I>[]> {
  const { scenarios, fixtures } = prepare(options);
  const results: ScenarioResult<I>[] = [];
  for (const scenario of scenarios) {
    const implementation = await newImplementation(initialStateOf(scenario));
    const evaluatedObligations = await refineScenarioAsync(
      scenario,
      await implementation.snapshot(),
      ownershipRecords,
      retrieve,
      fixtures,
      asyncDriver(implementation),
    );
    results.push({ scenario: scenarioId(scenario), evaluatedObligations, implementation });
  }
  return results;
}
`;
}

function generateMain(project) {
  const initializeValues = 'BTreeMap::from([("state".to_owned(), initial_state.clone())])';
  const methods = project.primitives.map(primitive => primitive.compound
    ? `    fn ${rustIdentifier(primitive.name)}(
        &mut self,
        actions: &[ResolvedAction],
    ) -> Result<Vec<Self::Evidence>, String> {
        Err(format!("implement ${primitive.name} for Quint actions {actions:?}"))
    }`
    : `    fn ${rustIdentifier(primitive.name)}(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        Err(format!("implement Quint action ${primitive.name} with arguments {arguments:?}"))
    }`
  ).join("\n\n");
  const imports = project.primitives.some(primitive => primitive.compound)
    ? "NormalizedRuntimeEvidence, ResolvedAction, RuntimeValue"
    : "NormalizedRuntimeEvidence, RuntimeValue";
  return `mod generated_refinement;

use std::collections::BTreeMap;

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{${imports}};

#[derive(Clone)]
struct Snapshot {
    values: BTreeMap<String, RuntimeValue>,
}

impl NormalizedRuntimeEvidence for Snapshot {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        self.values
            .get(name)
            .cloned()
            .ok_or_else(|| format!("unknown evidence name {name}"))
    }

    fn resolve_call(
        &self,
        _operator: &str,
        _arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        None
    }
}

struct App {
    values: BTreeMap<String, RuntimeValue>,
}

impl Implementation for App {
    type Evidence = Snapshot;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> {
        Ok(Self {
            values: ${initializeValues},
        })
    }

    fn snapshot(&self) -> Self::Evidence {
        Snapshot {
            values: self.values.clone(),
        }
    }

${methods}
}

fn main() {
    match refine_all::<App>() {
        Ok(results) => {
            for result in results {
                println!(
                    "{} refined {} obligations",
                    result.scenario, result.evaluated_obligations
                );
            }
        }
        Err(error) => {
            eprintln!("refinement failed: {error}");
            std::process::exit(1);
        }
    }
}
`;
}

const call = (operator, ...arguments_) => ({ kind: "call", operator, arguments: arguments_ });

// Turns one value from Quint's trace into the literal expression that denotes it.
function traceLiteral(value, context) {
  if (typeof value === "boolean") {
    return { kind: "bool", value };
  }
  if (typeof value === "string") {
    return { kind: "str", value };
  }
  if (typeof value === "number") {
    return { kind: "int", value };
  }
  if (Array.isArray(value)) {
    return call("List", ...value.map(item => traceLiteral(item, context)));
  }
  if (value && typeof value === "object") {
    if (value["#bigint"] !== undefined) {
      return { kind: "int", value: Number(value["#bigint"]) };
    }
    if (value["#set"]) {
      return call("Set", ...value["#set"].map(item => traceLiteral(item, context)));
    }
    if (value["#tup"]) {
      return call("Tup", ...value["#tup"].map(item => traceLiteral(item, context)));
    }
    if (value["#map"]) {
      return call("Map", ...value["#map"].map(([key, item]) =>
        call("Tup", traceLiteral(key, context), traceLiteral(item, context))
      ));
    }
    if (typeof value.tag === "string" && "value" in value && Object.keys(value).length === 2) {
      const unit = value.value?.["#tup"]?.length === 0;
      if (value.tag === "Absent" && unit) {
        return { kind: "name", value: "Absent" };
      }
      if (unit) {
        return { kind: "str", value: value.tag };
      }
      const payload = traceLiteral(value.value, context);
      return value.tag === "Present"
        ? call("Present", payload)
        : call("variant", { kind: "str", value: value.tag }, payload);
    }
    return call("Rec", ...Object.entries(value)
      .filter(([key]) => key !== "#meta" && !key.startsWith("__"))
      .flatMap(([key, item]) => [{ kind: "str", value: key }, traceLiteral(item, context)]));
  }
  fail(`${context}: Quint's trace holds a value the compiler cannot encode: ${JSON.stringify(value)}`);
}

// An action written with `any`, `nondet` or branching has no single
// `state' = ...` conjunct to check. Its scenario is still deterministic, so the
// state Quint reached after it is the obligation.
function attachTraceNext(steps, itf, context) {
  for (const step of steps) {
    if (step.kind !== "action" || (step.next ?? []).length > 0) {
      continue;
    }
    const after = itf?.states?.[step.index]?.state;
    if (after === undefined) {
      fail(`${context}: Quint produced no state after action ${step.action}`);
    }
    const expression = call(
      "assign",
      { kind: "name", value: "state" },
      traceLiteral(after, `${context}:${step.action}`),
    );
    step.next = [{
      scope: "runtime",
      expression,
      dependencies: observationDependencies(expression),
    }];
  }
}

function inferredApp(project) {
  // A generated project checks every obligation at runtime: nothing is
  // reserved for the model checker alone.
  const everything = { has: () => true };
  return defineConformanceApp({
    actions: project.actions,
    capabilities: project.capabilities,
    expressionOperators: project.expressionOperators,
    expressionNames: project.expressionNames,
    modelOnlyNames: [],
    modelOnlyOperators: [],
    initializers: [project.initializer],
    fixtureImports: project.fixtureImports,
    // Quint's REPL rejects a file whose later modules instantiate earlier
    // ones. Fixture values only need the scenario module and what precedes it.
    copySourceForFixtures: ({ source, sourceText }) => {
      if (source !== project.source) {
        return sourceText;
      }
      const starts = [...sourceText.matchAll(/^module\s+(\w+)/gm)];
      const index = starts.findIndex(match => match[1] === project.module);
      const next = starts[index + 1];
      return index >= 0 && next ? sourceText.slice(0, next.index) : sourceText;
    },
    requireObserve: true,
    attachActionNext: attachTraceNext,
    inlineObservations: true,
    retrieveForCapabilities: () => everything,
    actionRetrieveForCapabilities: () => everything,
    sources: () => [{
      source: project.source,
      module: project.module,
      init: project.initializer,
      step: project.step,
    }],
  });
}

function writeOrCheck(filePath, content, check) {
  if (check) {
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== content) {
      fail(`${path.basename(filePath)} drifted; run quint-refinements compile`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function formatRust(content) {
  const result = spawnSync("rustfmt", ["--edition", "2024", "--emit", "stdout"], {
    encoding: "utf8",
    input: content,
  });
  if (result.error) {
    fail(
      `could not start rustfmt (${result.error.message}); `
      + "install Rust from https://rustup.rs, then run `rustup component add rustfmt`",
    );
  }
  if (result.status !== 0) {
    fail(`rustfmt rejected generated Rust:\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function formatGo(content) {
  const result = spawnSync("gofmt", [], { encoding: "utf8", input: content });
  if (result.error) {
    fail(
      `could not start gofmt (${result.error.message}); `
      + "install Go from https://go.dev/dl",
    );
  }
  if (result.status !== 0) {
    fail(`gofmt rejected generated Go:\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

export function compileProject(sourceArgument, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const sourcePath = path.resolve(cwd, sourceArgument);
  if (!fs.existsSync(sourcePath)) {
    fail(`Quint source does not exist: ${sourcePath}`);
  }
  const projectDirectory = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
  const artifactPath = options.artifact
    ? path.resolve(cwd, options.artifact)
    : path.join(projectDirectory, "quint-refinements.json");
  // `--go` or `--typescript` alone selects a project without Rust; `--rust` adds the Rust adapter.
  const emitRust = options.rust !== undefined || (options.go === undefined && options.typescript === undefined);
  const generatedRustPath = options.rust
    ? path.resolve(cwd, options.rust)
    : path.join(projectDirectory, "src", "generated_refinement.rs");
  const generatedGoPath = options.go ? path.resolve(cwd, options.go) : undefined;
  const generatedTypescriptPath = options.typescript ? path.resolve(cwd, options.typescript) : undefined;
  const parsed = parseQuint(sourcePath);
  const project = inferProject(parsed, sourceName, options.module, { rust: emitRust, go: generatedGoPath !== undefined, typescript: generatedTypescriptPath !== undefined });
  const artifact = generateConformanceTraces({
    root: packageRoot,
    specDir: projectDirectory,
    app: inferredApp(project),
    fullyRefinedRuns: project.fullyRefinedRuns,
  });
  const generatedDependencies = new Set();
  for (const scenario of artifact.scenarios) {
    for (const step of scenario.steps) {
      for (const assertion of [...(step.guards ?? []), ...(step.next ?? []), ...(step.assertions ?? [])]) {
        (assertion.dependencies ?? []).forEach(dependency => generatedDependencies.add(dependency));
      }
    }
  }
  project.retrieve = [...generatedDependencies].sort();
  project.paths = project.retrieve.filter(dependency => dependency.startsWith("path:"));
  project.fixtureNames = Object.keys(artifact.fixtures?.[project.module] ?? {}).sort();
  // Every step inlines its obligations, so a large model's artifact is mostly
  // indentation; `compact` drops it.
  const artifactContent = `${JSON.stringify(artifact, null, options.compact ? undefined : 2)}\n`;
  const relativeArtifact = adapterPath => path
    .relative(path.dirname(adapterPath), artifactPath)
    .split(path.sep)
    .join("/");
  writeOrCheck(artifactPath, artifactContent, options.check);
  if (emitRust) {
    project.artifactInclude = relativeArtifact(generatedRustPath);
    writeOrCheck(generatedRustPath, formatRust(generateRustModule(project)), options.check);
  }
  if (generatedGoPath) {
    project.artifactInclude = relativeArtifact(generatedGoPath);
    const packageName = goPackageName(generatedGoPath, options.goPackage);
    writeOrCheck(generatedGoPath, formatGo(generateGoModule(project, packageName)), options.check);
  }
  if (generatedTypescriptPath) {
    project.artifactInclude = relativeArtifact(generatedTypescriptPath);
    writeOrCheck(generatedTypescriptPath, generateTypeScriptModule(project), options.check);
  }

  // The implementation file belongs to the user: scaffold it once, in the
  // standard project layout, and never overwrite it.
  const mainPath = path.join(projectDirectory, "src", "main.rs");
  if (emitRust && !options.check && !options.rust && !fs.existsSync(mainPath)) {
    writeOrCheck(mainPath, formatRust(generateMain(project)), false);
  }
  return {
    project,
    artifactPath,
    generatedRustPath: emitRust ? generatedRustPath : undefined,
    generatedGoPath,
    generatedTypescriptPath,
    mainPath,
  };
}

// A working implementation of the starter model, so a new project refines
// before the user changes anything.
const starterMain = `mod generated_refinement;

use std::collections::BTreeMap;

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

/// The code under test. Replace it with calls into your real implementation.
struct Counter {
    count: i64,
}

/// What the refinement checker may observe after each action.
#[derive(Clone)]
struct Snapshot {
    count: i64,
}

impl NormalizedRuntimeEvidence for Snapshot {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        match name {
            "state" => Ok(RuntimeValue::Record(BTreeMap::from([(
                "count".to_owned(),
                RuntimeValue::Int(self.count),
            )]))),
            other => Err(format!("unknown model name {other}")),
        }
    }

    fn resolve_call(
        &self,
        _operator: &str,
        _arguments: &[RuntimeValue],
    ) -> Option<Result<RuntimeValue, String>> {
        None
    }
}

impl Implementation for Counter {
    type Evidence = Snapshot;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> {
        let RuntimeValue::Record(state) = initial_state else {
            return Err(format!("expected a state record, got {initial_state:?}"));
        };
        let Some(RuntimeValue::Int(count)) = state.get("count") else {
            return Err(format!("state has no integer count: {state:?}"));
        };
        Ok(Self { count: *count })
    }

    fn snapshot(&self) -> Self::Evidence {
        Snapshot { count: self.count }
    }

    fn increment(&mut self, _arguments: &[RuntimeValue]) -> Result<(), String> {
        self.count += 1;
        Ok(())
    }
}

fn main() {
    match refine_all::<Counter>() {
        Ok(results) => {
            for result in results {
                println!(
                    "{} refined {} obligations",
                    result.scenario, result.evaluated_obligations
                );
            }
        }
        Err(error) => {
            eprintln!("refinement failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Counter, refine_all};

    #[test]
    fn counter_refines_every_quint_scenario() {
        if let Err(error) = refine_all::<Counter>() {
            panic!("refinement failed: {error}");
        }
    }
}
`;

function projectFiles(name) {
  return new Map([
    [".gitignore", "/node_modules\n/target\n"],
    ["Cargo.toml", `[package]
name = ${JSON.stringify(name)}
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
quint-refinements = ${JSON.stringify(packageMetadata.version)}

[lints.rust]
unsafe_code = "forbid"
`],
    ["package.json", `${JSON.stringify({
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        compile: "quint-refinements compile",
        check: "quint-refinements compile --check",
      },
      dependencies: {
        "quint-refinements": `^${packageMetadata.version}`,
      },
    }, null, 2)}\n`],
    ["model.qnt", `module counter {
  type State = { count: int }

  var state: State

  action init = all {
    state' = { count: 0 },
  }

  action increment = all {
    state' = { count: state.count + 1 },
  }

  /// @conformance
  run incrementRun = init
    .then(increment)
    .then(all {
      assert(state.count == 1),
      state' = state,
    })
}
`],
    ["src/main.rs", starterMain],
    ["README.md", `# ${name}

\`model.qnt\` is the specification. \`src/main.rs\` is the implementation it
checks. Everything between them is generated.

\`\`\`console
cargo run                        # refine the implementation against the model
npx quint-refinements compile    # regenerate after editing model.qnt
\`\`\`

After you change the model, \`cargo\` reports each action hook that
\`src/main.rs\` still has to implement.

Generated files, never edited by hand:

- \`quint-refinements.json\`: scenarios, guards and next-state obligations.
- \`src/generated_refinement.rs\`: the typed \`Implementation\` trait and runner.

Add \`npx quint-refinements compile --check\` to CI so they cannot drift from
the model.
`],
  ]);
}

export function createProject(name, options = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail("project name must use lowercase letters, numbers, and hyphens");
  }
  const destination = path.resolve(options.cwd ?? process.cwd(), name);
  if (fs.existsSync(destination)) {
    fail(`destination already exists: ${destination}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const [relativePath, content] of projectFiles(name)) {
    const filePath = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  compileProject(defaultSource, { cwd: destination });
  if (options.install !== false) {
    run("npm", ["install"], { cwd: destination });
  }
  return destination;
}

const defaultSource = "model.qnt";

function usage() {
  console.log(`quint-refinements: check a Rust, Go or TypeScript implementation against a Quint model

Usage:
  quint-refinements new <project-name> [--no-install]
      Create a project that already refines: model.qnt, a Rust implementation
      and the generated adapter between them.

  quint-refinements compile [spec.qnt] [options]
      Generate the scenario artifact and the Rust, Go or TypeScript adapter from a Quint model.
      The model defaults to ${defaultSource}.

      --check            Fail if the generated files differ from the model (CI)
      --module <name>    Module to compile when several declare scenarios
      --artifact <path>  Scenario artifact (default: quint-refinements.json)
      --rust <path>      Rust adapter (default: src/generated_refinement.rs)
      --go <path>        Go adapter. Without --rust, only the Go adapter is
                         written. The artifact must sit inside the adapter's
                         directory, which is where Go embeds it from.
      --go-package <n>   Go package name (default: the adapter's directory name)
      --typescript <path>
                         TypeScript adapter. Without --rust, only the TypeScript
                         adapter is written. It imports quint-refinements/runtime
                         and reads the artifact from beside itself.
      --compact          Write the artifact without indentation

In the model:
  /// @conformance                       marks a run as a refinement scenario
  /// @primitive commit = [prepare, flushWal, commitPrepared]
                                         in the module comment: one command
                                         implements several actions in order

Docs: ${packageMetadata.homepage}
`);
}

function optionValue(arguments_, option) {
  const index = arguments_.indexOf(option);
  if (index < 0) {
    return undefined;
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${option} requires a value`);
  }
  arguments_.splice(index, 2);
  return value;
}

function main(arguments_) {
  const args = [...arguments_];
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "--version" || command === "-V") {
    console.log(packageMetadata.version);
    return;
  }
  if (command === "new") {
    const name = args.shift();
    if (!name) {
      fail("new requires a project name");
    }
    const noInstall = args.includes("--no-install");
    const unexpected = args.filter(argument => argument !== "--no-install");
    if (unexpected.length > 0) {
      fail(`unexpected new arguments: ${unexpected.join(" ")}`);
    }
    const destination = createProject(name, { install: !noInstall });
    console.log(`created ${destination}

Next:
  cd ${name}
  cargo run`);
    return;
  }
  if (command === "compile") {
    const module = optionValue(args, "--module");
    const artifact = optionValue(args, "--artifact");
    const rust = optionValue(args, "--rust");
    const go = optionValue(args, "--go");
    const typescript = optionValue(args, "--typescript");
    const goPackage = optionValue(args, "--go-package");
    const check = args.includes("--check");
    const compact = args.includes("--compact");
    const positional = args.filter(argument => argument !== "--check" && argument !== "--compact");
    if (positional.length > 1 || positional.some(argument => argument.startsWith("--"))) {
      fail(`unexpected compile arguments: ${positional.join(" ")}`);
    }
    const result = compileProject(positional[0] ?? defaultSource, { module, check, compact, artifact, rust, go, goPackage, typescript });
    const written = [result.artifactPath, result.generatedRustPath, result.generatedGoPath, result.generatedTypescriptPath]
      .filter(Boolean)
      .map(file => path.relative(process.cwd(), file));
    console.log(
      check
        ? `${result.project.module} generated artifacts are current`
        : `generated ${written.join(" and ")}`,
    );
    return;
  }
  fail(`unknown command ${command}; run quint-refinements --help`);
}

const invokedDirectly = process.argv[1]
  && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
