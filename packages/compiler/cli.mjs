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
    run(quintBinary(), ["parse", sourcePath, `--out=${outputPath}`], {
      cwd: path.dirname(sourcePath),
      capture: true,
    });
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if ((parsed.errors ?? []).length > 0) {
      fail(parsed.errors.map(error => error.explanation ?? JSON.stringify(error)).join("\n"));
    }
    return parsed;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function inferProject(parsed, sourceName, requestedModule) {
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
  const observationOperators = [...vocabulary.operators]
    .filter(operator => !["actionAll", "assert", "assign"].includes(operator))
    .sort();

  return {
    source: sourceName,
    module: module.name,
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

    /// Bind model fixtures to production values when the model declares fixtures.
    fn fixtures() -> FixtureTable {
        FixtureTable::new(${rustString(project.module)})
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
    let fixtures = I::fixtures();
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

function inferredApp(project) {
  const retrieve = new Set(project.retrieve);
  return defineConformanceApp({
    actions: project.actions,
    capabilities: project.capabilities,
    expressionOperators: project.expressionOperators,
    expressionNames: project.expressionNames,
    modelOnlyNames: [],
    modelOnlyOperators: [],
    initializers: [project.initializer],
    fixtureImports: [],
    requireObserve: true,
    inlineObservations: true,
    retrieveForCapabilities: () => new Set(retrieve),
    actionRetrieveForCapabilities: () => new Set(retrieve),
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
  const generatedRustPath = options.rust
    ? path.resolve(cwd, options.rust)
    : path.join(projectDirectory, "src", "generated_refinement.rs");
  const parsed = parseQuint(sourcePath);
  const project = inferProject(parsed, sourceName, options.module);
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
  project.artifactInclude = path
    .relative(path.dirname(generatedRustPath), artifactPath)
    .split(path.sep)
    .join("/");
  const artifactContent = `${JSON.stringify(artifact, null, 2)}\n`;
  const generatedRust = formatRust(generateRustModule(project));
  writeOrCheck(artifactPath, artifactContent, options.check);
  writeOrCheck(generatedRustPath, generatedRust, options.check);

  // The implementation file belongs to the user: scaffold it once, in the
  // standard project layout, and never overwrite it.
  const mainPath = path.join(projectDirectory, "src", "main.rs");
  if (!options.check && !options.rust && !fs.existsSync(mainPath)) {
    writeOrCheck(mainPath, formatRust(generateMain(project)), false);
  }
  return { project, artifactPath, generatedRustPath, mainPath };
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
  console.log(`quint-refinements: check a Rust implementation against a Quint model

Usage:
  quint-refinements new <project-name> [--no-install]
      Create a project that already refines: model.qnt, a Rust implementation
      and the generated adapter between them.

  quint-refinements compile [spec.qnt] [options]
      Generate the scenario artifact and the Rust adapter from a Quint model.
      The model defaults to ${defaultSource}.

      --check            Fail if the generated files differ from the model (CI)
      --module <name>    Module to compile when several declare scenarios
      --artifact <path>  Scenario artifact (default: quint-refinements.json)
      --rust <path>      Rust adapter (default: src/generated_refinement.rs)

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
    const check = args.includes("--check");
    const positional = args.filter(argument => argument !== "--check");
    if (positional.length > 1 || positional.some(argument => argument.startsWith("--"))) {
      fail(`unexpected compile arguments: ${positional.join(" ")}`);
    }
    const result = compileProject(positional[0] ?? defaultSource, { module, check, artifact, rust });
    console.log(
      check
        ? `${result.project.module} generated artifacts are current`
        : `generated ${path.relative(process.cwd(), result.artifactPath)} and ${path.relative(process.cwd(), result.generatedRustPath)}`,
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
