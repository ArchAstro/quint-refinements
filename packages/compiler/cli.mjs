#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
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

function conformanceCapabilities(doc, context) {
  const directives = (doc ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("@conformance"));
  if (directives.length !== 1) {
    fail(`${context} must have exactly one @conformance directive`);
  }
  const match = directives[0].match(
    /^@conformance requires = \[([a-z0-9._]+(?:, [a-z0-9._]+)*)\]$/,
  );
  if (!match) {
    fail(`${context} has a malformed @conformance directive`);
  }
  return match[1].split(", ");
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
    conformanceCapabilities(
      runDeclaration.doc,
      `${sourceName}:${module.name}.${runDeclaration.name}`,
    ).forEach(capability => capabilities.add(capability));
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
        actions.add(node.name);
      } else if (node?.kind === "app") {
        actions.add(node.opcode);
      } else {
        fail(`${runDeclaration.name} contains an unsupported ${node?.kind ?? "unknown"} step`);
      }
    }
  }
  if (initializers.size !== 1) {
    fail(`conformance runs must share one initializer; found ${[...initializers].join(", ")}`);
  }
  if (actions.size === 0) {
    fail("conformance runs contain no implementation actions");
  }

  const actionDefinitions = new Map(
    module.declarations
      .filter(declaration => declaration.kind === "def" && declaration.qualifier === "action")
      .map(declaration => [declaration.name, declaration]),
  );
  for (const action of actions) {
    const definition = actionDefinitions.get(action);
    if (!definition) {
      fail(`conformance action ${action} has no action definition in module ${module.name}`);
    }
    collectAstVocabulary(definition.expr, vocabulary);
  }
  for (const declaration of module.declarations) {
    if (declaration.kind === "def" && declaration.qualifier !== "run") {
      collectAstVocabulary(declaration.expr, vocabulary);
    }
  }

  const stateVariables = module.declarations
    .filter(declaration => declaration.kind === "var")
    .map(declaration => declaration.name)
    .sort();
  stateVariables.forEach(name => {
    vocabulary.names.add(name);
    vocabulary.retrieve.add(`name:${name}`);
  });

  const initializer = [...initializers][0];
  const sortedActions = [...actions].sort();
  const rustActions = new Map();
  for (const action of sortedActions) {
    const generatedCapability = `${module.name}.${action}`;
    if (!capabilities.has(generatedCapability)) {
      fail(
        `generated one-to-one ownership requires capability ${generatedCapability}; `
        + "use the lower-level generator for compound or custom ownership",
      );
    }
    const identifier = rustIdentifier(action);
    if (rustKeywords.has(identifier)) {
      fail(`Quint action ${action} maps to reserved Rust keyword ${identifier}`);
    }
    const existing = rustActions.get(identifier);
    if (existing) {
      fail(`Quint actions ${existing} and ${action} both map to Rust identifier ${identifier}`);
    }
    rustActions.set(identifier, action);
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

export function generateRustModule(project) {
  const ownershipConstants = project.actions.map(action => {
    const observations = project.paths.map(rustString).join(", ");
    const retrieveNames = project.stateVariables.map(name => rustString(`name:${name}`)).join(", ");
    return `quint_ownership! {
    const ${rustConstant(action)} = {
        primitive: ${rustString(`${project.module}.${action}`)},
        refines: [${rustString(action)}],
        aliases: [],
        observations: [${observations}],
        retrieve: [${retrieveNames}],
    };
}`;
  }).join("\n\n");
  const descriptors = project.actions.map(action => rustConstant(action)).join(", ");
  const retrieve = project.retrieve.map(value => `    ${rustString(value)},`).join("\n");
  const traitMethods = project.actions.map(action => `    /// Execute Quint action \`${action}\` with its generated arguments.
    fn ${rustIdentifier(action)}(&mut self, arguments: &[RuntimeValue]) -> Result<(), String>;`).join("\n");
  const matchArms = project.actions.map(action => `            ${rustString(`${project.module}.${action}`)} => {
                let [action] = actions else {
                    return Err(format!("${action} expects one Quint action; got {actions:?}"));
                };
                if action.name != ${rustString(action)} {
                    return Err(format!("${action} primitive cannot refine {}", action.name));
                }
                self.implementation.${rustIdentifier(action)}(&action.arguments)?;
                Ok(vec![self.implementation.snapshot()])
            }`).join("\n");

  return `// @generated by quint-refinements. Regenerate with the compile command.
use quint_refinements::{
    ConformanceArtifact, FixtureTable, NormalizedRuntimeEvidence, OwnershipTable,
    PrimitiveDriver, ResolvedAction, RuntimeValue, collect_ownership_records,
    quint_ownership, refine_scenario,
};

const TRACES: &str = include_str!("../quint-refinements.json");

${ownershipConstants}

const OWNERSHIP: OwnershipTable = OwnershipTable {
    owner: ${rustString(`${project.module}-generated-refinement`)},
    descriptors: &[${descriptors}],
};

const RETRIEVE: &[&str] = &[
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

struct Driver<I> {
    implementation: I,
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

/// Run every generated conformance scenario against a fresh implementation.
pub fn refine_all<I: Implementation>() -> Result<Vec<ScenarioResult<I>>, String> {
    let artifact = ConformanceArtifact::parse(TRACES).map_err(|error| error.to_string())?;
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
  const initializeValues = project.stateVariables.length === 1
    ? `BTreeMap::from([(${rustString(project.stateVariables[0])}.to_owned(), initial_state.clone())])`
    : `match initial_state {
            RuntimeValue::Record(values) => values.clone(),
            other => return Err(format!("expected record initial state, got {other:?}")),
        }`;
  const methods = project.actions.map(action => `    fn ${rustIdentifier(action)}(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        Err(format!("implement Quint action ${action} with arguments {arguments:?}"))
    }`).join("\n\n");
  return `mod generated_refinement;

use std::collections::BTreeMap;

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

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
    fail(`could not start rustfmt: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`rustfmt rejected generated Rust:\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

export function compileProject(sourceArgument, options = {}) {
  const sourcePath = path.resolve(options.cwd ?? process.cwd(), sourceArgument);
  if (!fs.existsSync(sourcePath)) {
    fail(`Quint source does not exist: ${sourcePath}`);
  }
  const projectDirectory = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
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
  const artifactContent = `${JSON.stringify(artifact, null, 2)}\n`;
  const generatedRust = formatRust(generateRustModule(project));
  const artifactPath = path.join(projectDirectory, "quint-refinements.json");
  const generatedRustPath = path.join(projectDirectory, "src", "generated_refinement.rs");
  writeOrCheck(artifactPath, artifactContent, options.check);
  writeOrCheck(generatedRustPath, generatedRust, options.check);

  const mainPath = path.join(projectDirectory, "src", "main.rs");
  if (!options.check && !fs.existsSync(mainPath)) {
    writeOrCheck(mainPath, formatRust(generateMain(project)), false);
  }
  return { project, artifactPath, generatedRustPath, mainPath };
}

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
        compile: "quint-refinements compile model.qnt",
        check: "quint-refinements compile model.qnt --check",
      },
      dependencies: {
        "@archastro/quint-refinements": `^${packageMetadata.version}`,
      },
    }, null, 2)}\n`],
    ["model.qnt", `module model {
  var state: int

  action init = all {
    state' = 0,
  }

  action advance = all {
    state' = state + 1,
  }

  /// @conformance requires = [model.advance]
  run advanceRun = init
    .then(advance)
    .then(all {
      assert(state == 1),
      state' = state,
    })
}
`],
    ["README.md", `# ${name}

1. Edit \`model.qnt\` until Quint accepts the model.
2. Run \`npx quint-refinements compile model.qnt\`.
3. Implement the generated action hooks in \`src/main.rs\`.
4. Run \`cargo test\` or \`cargo run\`.
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
  if (options.install !== false) {
    run("npm", ["install"], { cwd: destination });
  }
  return destination;
}

function usage() {
  console.log(`quint-refinements

Usage:
  quint-refinements new <project-name> [--no-install]
  quint-refinements compile <spec.qnt> [--module <name>] [--check]
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
    console.log(`created ${destination}`);
    return;
  }
  if (command === "compile") {
    const source = args.shift();
    if (!source) {
      fail("compile requires a Quint source path");
    }
    const module = optionValue(args, "--module");
    const check = args.includes("--check");
    const unexpected = args.filter(argument => argument !== "--check");
    if (unexpected.length > 0) {
      fail(`unexpected compile arguments: ${unexpected.join(" ")}`);
    }
    const result = compileProject(source, { module, check });
    console.log(
      check
        ? `${result.project.module} generated artifacts are current`
        : `generated ${path.relative(process.cwd(), result.artifactPath)} and ${path.relative(process.cwd(), result.generatedRustPath)}`,
    );
    return;
  }
  fail(`unknown command ${command}`);
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
