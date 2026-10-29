import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compileProject, createProject, goMethodName, typescriptMethodName } from "./cli.mjs";
import { defineConformanceApp, generateConformanceTraces, shareAssertionLists } from "./generate.mjs";

const compilerRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(compilerRoot, "..", "..");
const rustBindingRoot = path.join(repositoryRoot, "bindings", "rust");
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);

const rustVersion = fs.readFileSync(path.join(rustBindingRoot, "Cargo.toml"), "utf8")
  .match(/^version = "([^"]+)"$/m)[1];
// Resolves the scaffolded registry dependency to this checkout's runtime
// without touching the generated manifest.
const localRuntime = [
  "--config",
  `patch.crates-io.quint-refinements.path=${JSON.stringify(rustBindingRoot)}`,
];
const bankModel = fs.readFileSync(
  path.join(repositoryRoot, "examples", "rust", "bank_account", "bank.qnt"),
  "utf8",
);
const twoPhaseCommitModel = fs.readFileSync(
  path.join(rustBindingRoot, "examples", "two_phase_commit", "model.qnt"),
  "utf8",
);

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-test-"));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeModel(directory, source, name = "model.qnt") {
  fs.writeFileSync(path.join(directory, name), source);
}

test("the compiler and the Rust runtime release under one version", () => {
  // `new` writes the compiler's version as the crate requirement.
  assert.equal(rustVersion, packageMetadata.version);
});

test("a new project refines its implementation without any edits", () => {
  withTemporaryDirectory(directory => {
    const projectDirectory = createProject("counter-refinement", {
      cwd: directory,
      install: false,
    });

    assert.match(
      fs.readFileSync(path.join(projectDirectory, "Cargo.toml"), "utf8"),
      new RegExp(`^quint-refinements = "${rustVersion.replaceAll(".", "\\.")}"$`, "m"),
    );
    const cargo = spawnSync(
      "cargo",
      ["run", "--quiet", "--manifest-path", path.join(projectDirectory, "Cargo.toml"), ...localRuntime],
      { encoding: "utf8" },
    );

    assert.equal(cargo.status, 0, cargo.stderr);
    assert.match(cargo.stdout, /counter\.incrementRun refined 1 obligations/);
    compileProject("model.qnt", { cwd: projectDirectory, check: true });
  });
});

test("compile derives the whole integration from the Quint AST", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel
      .replace(
        "  /// @conformance",
        `  def expectedBalance: bool = state.balance == 6

  /// @conformance`,
      )
      .replace("assert(state.balance == 6)", "assert(expectedBalance)")
      .replace(/\n}\s*$/, `

  // Ordinary Quint runs do not become refinement scenarios.
  run exploratory = init.then(withdraw(1))
}
`));

    const result = compileProject("model.qnt", { cwd: directory });

    assert.equal(result.project.module, "bank");
    assert.deepEqual(result.project.actions, ["withdraw"]);
    assert.deepEqual(result.project.capabilities, ["bank.withdraw"]);
    const artifact = JSON.parse(
      fs.readFileSync(path.join(directory, "quint-refinements.json"), "utf8"),
    );
    assert.deepEqual(artifact.scenarios.map(scenario => scenario.name), ["withdrawRun"]);
    assert.doesNotMatch(JSON.stringify(artifact), /name:expectedBalance/);
    assert.match(
      fs.readFileSync(path.join(directory, "src", "generated_refinement.rs"), "utf8"),
      /fn withdraw\(&mut self, arguments: &\[RuntimeValue\]\)/,
    );
    assert.match(
      fs.readFileSync(path.join(directory, "src", "main.rs"), "utf8"),
      /implement Quint action withdraw/,
    );
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      ["model.qnt", "quint-refinements.json", "src"],
    );

    compileProject("model.qnt", { cwd: directory, check: true });
  });
});

test("an artifact stores each distinct guard and next list once, in order of first appearance", () => {
  withTemporaryDirectory(directory => {
    const { artifact } = compileShop(directory);

    assert.equal(artifact.schemaVersion, 3);
    const steps = artifact.scenarios.flatMap(scenario => scenario.steps);
    const actions = steps.filter(step => step.kind === "action");
    assert.ok(steps.every(step => !("guards" in step) && !("next" in step)));
    const references = actions.flatMap(step => [step.guardList, step.nextList]).filter(index => index !== undefined);
    assert.ok(references.every(index => Number.isInteger(index) && index < artifact.assertionLists.length));
    // First appearance: each new index is the next unused one.
    let highest = -1;
    for (const index of references) {
      assert.ok(index <= highest + 1);
      highest = Math.max(highest, index);
    }
    assert.equal(highest, artifact.assertionLists.length - 1);
    const distinct = new Set(artifact.assertionLists.map(list => JSON.stringify(list)));
    assert.equal(distinct.size, artifact.assertionLists.length);
  });
});

test("shareAssertionLists stores a repeated list once and numbers lists by first appearance", () => {
  const assertion = value => ({ scope: "runtime", expression: { kind: "int", value }, dependencies: [] });
  const [a, b] = [[assertion(1)], [assertion(2)]];
  const action = (guards, next) => ({ kind: "action", index: 1, action: "go", arguments: [], guards, next });
  const { assertionLists, scenarios } = shareAssertionLists([
    { name: "one", steps: [{ kind: "init", index: 0 }, action(a, b), action([], b)] },
    { name: "two", steps: [action(structuredClone(b), structuredClone(a)), { kind: "observe", index: 2, assertions: a }] },
  ]);

  assert.deepEqual(assertionLists, [a, b]);
  assert.deepEqual(scenarios[0].steps, [
    { kind: "init", index: 0 },
    { kind: "action", index: 1, action: "go", arguments: [], guardList: 0, nextList: 1 },
    { kind: "action", index: 1, action: "go", arguments: [], nextList: 1 },
  ]);
  assert.deepEqual(scenarios[1].steps[0], { kind: "action", index: 1, action: "go", arguments: [], guardList: 1, nextList: 0 });
  assert.deepEqual(scenarios[1].steps[1].assertions, a);
});

test("--compact writes the same artifact on one line, and --check compares that", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    const artifactPath = path.join(directory, "quint-refinements.json");
    compileProject("model.qnt", { cwd: directory });
    const indented = fs.readFileSync(artifactPath, "utf8");

    compileProject("model.qnt", { cwd: directory, compact: true });
    const compact = fs.readFileSync(artifactPath, "utf8");

    assert.deepEqual(JSON.parse(compact), JSON.parse(indented));
    assert.equal(compact.trimEnd().includes("\n"), false);
    assert.ok(compact.length < indented.length);
    compileProject("model.qnt", { cwd: directory, compact: true, check: true });
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory, check: true }),
      /quint-refinements\.json drifted/,
    );
  });
});

test("compile never overwrites the user's implementation and reports drift", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    const { mainPath } = compileProject("model.qnt", { cwd: directory });
    fs.writeFileSync(mainPath, "// mine\n");

    writeModel(directory, bankModel.replace("withdraw(4)", "withdraw(3)").replace("== 6", "== 7"));
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory, check: true }),
      /quint-refinements\.json drifted; run quint-refinements compile/,
    );
    compileProject("model.qnt", { cwd: directory });

    assert.equal(fs.readFileSync(mainPath, "utf8"), "// mine\n");
    compileProject("model.qnt", { cwd: directory, check: true });
  });
});

test("one @primitive line gives a command an ordered sequence of camelCase actions", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, twoPhaseCommitModel);

    const result = compileProject("model.qnt", {
      cwd: directory,
      artifact: "generated/traces.json",
      rust: "adapter/generated.rs",
    });

    assert.deepEqual(
      result.project.primitives.map(primitive => [primitive.name, primitive.actions]),
      [
        ["abort", ["abort"]],
        ["begin", ["begin"]],
        ["commit", ["prepare", "flushWal", "commitPrepared"]],
      ],
    );
    const rust = fs.readFileSync(path.join(directory, "adapter", "generated.rs"), "utf8");
    assert.match(rust, /include_str!\("\.\.\/generated\/traces\.json"\)/);
    assert.match(rust, /refines: \["prepare", "flushWal", "commitPrepared"\]/);
    assert.match(rust, /fn commit\(&mut self, actions: &\[ResolvedAction\]\) -> Result<Vec<Self::Evidence>, String>;/);
    assert.doesNotMatch(rust, /fn flush_wal/);
    // Custom output paths mean the caller owns the layout: no main.rs scaffold.
    assert.equal(fs.existsSync(path.join(directory, "src")), false);
  });
});

test("scenarios may import their model from another file", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel.replace(/\n  \/\/\/ @conformance[\s\S]*$/, "}\n"), "bank.qnt");
    writeModel(directory, `module scenarios {
  import bank.* from "./bank"

  /// @conformance
  run withdrawRun = init
    .then(withdraw(4))
    .then(all {
      assert(state.balance == 6),
      state' = state,
    })
}
`);

    const result = compileProject("model.qnt", { cwd: directory });

    assert.equal(result.project.module, "scenarios");
    assert.deepEqual(result.project.primitives.map(primitive => primitive.name), ["withdraw"]);
  });
});

const shopDirectory = path.join(repositoryRoot, "examples", "rust", "shop_orders");

function compileShop(directory, edit = source => source) {
  fs.copyFileSync(path.join(shopDirectory, "shop.qnt"), path.join(directory, "shop.qnt"));
  writeModel(directory, edit(fs.readFileSync(path.join(shopDirectory, "model.qnt"), "utf8")));
  const result = compileProject("model.qnt", { cwd: directory });
  return {
    ...result,
    artifact: JSON.parse(fs.readFileSync(result.artifactPath, "utf8")),
    rust: fs.readFileSync(result.generatedRustPath, "utf8"),
  };
}

test("constants passed to actions take their value from the model", () => {
  withTemporaryDirectory(directory => {
    const { artifact, rust } = compileShop(directory);

    // `bagel` appears only as an action argument, never in an observation.
    assert.deepEqual(artifact.fixtures.scenarios, {
      bagel: { id: "bagel", total: 12 },
      coffee: { id: "coffee", total: 30 },
    });
    const pay = artifact.scenarios
      .find(scenario => scenario.name === "payBothRun").steps
      .filter(step => step.kind === "action");
    assert.deepEqual(pay.map(step => step.arguments), [
      [{ kind: "name", value: "coffee" }],
      [{ kind: "name", value: "bagel" }],
    ]);
    // The generated default binds them, so the implementation declares nothing.
    assert.match(rust, /FixtureTable::from_artifact\("scenarios", artifact\)/);
  });
});

test("a map constant reaches the runtime as ITF key/value pairs", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, `module ledger {
  type State = { balances: str -> int }
  pure val opening: str -> int = Map("alice" -> 3, "bob" -> 4)
  pure val grid: (int, int) -> str = Map((0, 1) -> "x")
  var state: State
  action init = all { state' = { balances: Map() } }
  action open(b: str -> int, g: (int, int) -> str): bool = all {
    g.keys().contains((0, 1)),
    state' = { balances: b },
  }
  /// @conformance
  run openRun = init
    .then(open(opening, grid))
    .then(all { assert(state.balances.get("bob") == 4), state' = state })
}
`);
    const result = compileProject("model.qnt", { cwd: directory });
    const artifact = JSON.parse(fs.readFileSync(result.artifactPath, "utf8"));

    // The runtime decodes `#map` entries as [key, value] arrays, as the
    // initial and reached states already write them.
    assert.deepEqual(artifact.fixtures.ledger, {
      grid: { "#map": [[{ "#tup": [0, 1] }, "x"]] },
      opening: { "#map": [["alice", 3], ["bob", 4]] },
    });
  });
});

test("every generated obligation is checked at runtime", () => {
  withTemporaryDirectory(directory => {
    const { artifact } = compileShop(directory);

    const scopes = [
      ...artifact.assertionLists.flat(),
      ...artifact.scenarios.flatMap(scenario => scenario.steps).flatMap(step => step.assertions ?? []),
    ].map(assertion => assertion.scope);
    assert.ok(scopes.length > 0);
    assert.deepEqual([...new Set(scopes)], ["runtime"]);
  });
});

test("an action without a plain assignment is held to the state Quint reached", () => {
  withTemporaryDirectory(directory => {
    const { artifact } = compileShop(directory);

    // `refund` is an if/else, so it has no single `state' = ...` conjunct.
    const refunds = artifact.scenarios
      .find(scenario => scenario.name === "refundRun").steps
      .filter(step => step.action === "refund");
    const expectedStates = refunds.map(step => {
      const next = artifact.assertionLists[step.nextList];
      assert.equal(next.length, 1);
      const { operator, arguments: [target, value] } = next[0].expression;
      assert.equal(operator, "assign");
      assert.deepEqual(target, { kind: "name", value: "state" });
      return value;
    });
    const emptyShop = {
      kind: "call",
      operator: "Rec",
      arguments: [
        { kind: "str", value: "paid" },
        { kind: "call", operator: "Set", arguments: [] },
        { kind: "str", value: "revenue" },
        { kind: "int", value: 0 },
      ],
    };
    assert.deepEqual(expectedStates, [emptyShop, emptyShop]);
  });
});

test("an assertion may combine conditions with all { }", () => {
  withTemporaryDirectory(directory => {
    const { artifact } = compileShop(directory);

    const observation = artifact.scenarios
      .find(scenario => scenario.name === "refundRun").steps.at(-1);
    assert.equal(observation.assertions[0].expression.operator, "actionAll");
  });
});

test("a scenario file may hold further modules after the scenarios", () => {
  withTemporaryDirectory(directory => {
    const { project } = compileShop(directory, source => `${source}
module exploration {
  import shop.* from "./shop"
  import scenarios.*

  action step = any {
    pay(coffee),
    refund(coffee),
  }
}
`);

    assert.equal(project.module, "scenarios");
    assert.deepEqual(project.fixtureImports, [{ module: "shop", source: "shop" }]);
  });
});

test("models the runtime cannot check are rejected with the fix", () => {
  const cases = [
    [
      bankModel.replaceAll("state", "account"),
      /declares state variables \[account\]; keep the whole model state in one `var state`/,
    ],
    [
      `module counter {
  var state: int
  action init = state' = 0
  action increment = state' = state + 1
  /// @conformance
  run incrementRun = init.then(increment).then(all { assert(state == 1), state' = state })
}
`,
      /declares `var state` as a int; make it a record/,
    ],
    [
      twoPhaseCommitModel.replace("[prepare, flushWal, commitPrepared]", "[prepare, vacuum]"),
      /@primitive commit owns vacuum, which no conformance run executes/,
    ],
    [
      twoPhaseCommitModel.replace("@primitive commit = [", "@primitive commit: ["),
      /malformed @primitive directive; write `@primitive name = \[firstAction, secondAction\]`/,
    ],
    [
      bankModel.replace("state.balance >= amount,", "state.balance >= amoun,"),
      /Quint rejected the model:\n  model\.qnt:13:22: \[QNT404\] Name 'amoun' not found/,
    ],
    [
      bankModel.replace("/// @conformance", "/// @conformance please"),
      /malformed @conformance directive; write `@conformance`/,
    ],
  ];
  for (const [model, expected] of cases) {
    withTemporaryDirectory(directory => {
      writeModel(directory, model);
      assert.throws(() => compileProject("model.qnt", { cwd: directory }), expected);
    });
  }
});

test("the low-level generator keeps observation helpers by name unless the app opts in", () => {
  withTemporaryDirectory(directory => {
    // Setup: a fully refined run whose observation calls a helper definition.
    writeModel(directory, bankModel
      .replace(
        "  /// @conformance",
        `  def expectedBalance: bool = state.balance == 6

  /// @conformance`,
      )
      .replace("assert(state.balance == 6)", "assert(expectedBalance)"));
    const observation = inlineObservations => {
      const artifact = generateConformanceTraces({
        root: repositoryRoot,
        specDir: directory,
        fullyRefinedRuns: new Set(["bank.withdrawRun"]),
        app: defineConformanceApp({
          actions: ["withdraw"],
          capabilities: ["bank.withdraw"],
          expressionOperators: ["eq", "field"],
          expressionNames: ["expectedBalance", "state"],
          initializers: ["init"],
          inlineObservations,
          sources: () => [{ source: "model.qnt", module: "bank", init: "init", step: "withdraw" }],
        }),
      });
      return artifact.scenarios[0].steps.at(-1).assertions[0].expression;
    };

    // An app with a closed vocabulary resolves `expectedBalance` at runtime.
    assert.deepEqual(observation(undefined), { kind: "name", value: "expectedBalance" });
    assert.equal(observation(true).operator, "eq");
  });
});

test("the npm-style symlink invokes the CLI entrypoint", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-bin-test-"));
  try {
    const binaryPath = path.join(temporaryRoot, "quint-refinements");
    fs.symlinkSync(path.join(compilerRoot, "cli.mjs"), binaryPath);

    const invocation = spawnSync(binaryPath, ["--help"], { encoding: "utf8" });

    assert.equal(invocation.status, 0, invocation.stderr);
    assert.match(invocation.stdout, /quint-refinements compile \[spec\.qnt\]/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a packed npm install creates and compiles a project with hoisted Quint", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-pack-test-"));
  try {
    // Package boundary: build the same tarball npm publishes, then install it as a consumer.
    const packed = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const [{ filename }] = JSON.parse(packed.stdout);
    const consumerDirectory = path.join(temporaryRoot, "consumer");
    fs.mkdirSync(consumerDirectory);
    const installed = spawnSync(
      "npm",
      ["install", "--prefix", consumerDirectory, path.join(temporaryRoot, filename)],
      { encoding: "utf8" },
    );
    assert.equal(installed.status, 0, installed.stderr);
    const audited = spawnSync(
      "npm",
      ["audit", "--prefix", consumerDirectory, "--audit-level=high"],
      { encoding: "utf8" },
    );
    assert.equal(audited.status, 0, `${audited.stdout}\n${audited.stderr}`);

    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import("quint-refinements/harness/generate.mjs")',
      ],
      { cwd: consumerDirectory, encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);

    // CLI boundary: invoke npm's binary symlink and let it resolve the hoisted Quint parser.
    const binary = path.join(
      consumerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "quint-refinements.cmd" : "quint-refinements",
    );
    const created = spawnSync(binary, ["new", "counter", "--no-install"], {
      cwd: consumerDirectory,
      encoding: "utf8",
    });
    assert.equal(created.status, 0, created.stderr);
    const generatedPackage = JSON.parse(
      fs.readFileSync(path.join(consumerDirectory, "counter", "package.json"), "utf8"),
    );
    assert.deepEqual(generatedPackage.dependencies, {
      "quint-refinements": `^${packageMetadata.version}`,
    });
    // Observable outcome: `new` alone delivers every generated Rust boundary artifact,
    // and the installed CLI agrees they match the model.
    assert.ok(fs.existsSync(path.join(consumerDirectory, "counter", "quint-refinements.json")));
    assert.ok(fs.existsSync(
      path.join(consumerDirectory, "counter", "src", "generated_refinement.rs"),
    ));
    const checked = spawnSync(binary, ["compile", "--check"], {
      cwd: path.join(consumerDirectory, "counter"),
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr);

    // Rust boundary: the manifest exactly as scaffolded, resolved to this checkout's runtime.
    const cargo = spawnSync(
      "cargo",
      [
        "test",
        "--manifest-path",
        path.join(consumerDirectory, "counter", "Cargo.toml"),
        ...localRuntime,
      ],
      { encoding: "utf8" },
    );
    assert.equal(cargo.status, 0, cargo.stderr);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

const goBindingRoot = path.join(repositoryRoot, "bindings", "go");

// A module that resolves the Go runtime to this checkout, so the generated
// adapter can be compiled without a network.
function writeGoModule(directory) {
  fs.writeFileSync(path.join(directory, "go.mod"), `module example.test/adapter

go 1.22

require github.com/ArchAstro/quint-refinements/bindings/go v0.0.0

replace github.com/ArchAstro/quint-refinements/bindings/go => ${goBindingRoot}
`);
}

test("Go method names are exported, idiomatic, and agree for snake and camel case", () => {
  assert.equal(goMethodName("withdraw"), "Withdraw");
  assert.equal(goMethodName("flushWal"), "FlushWal");
  assert.equal(goMethodName("flush_wal"), "FlushWal");
  assert.equal(goMethodName("commitPrepared"), "CommitPrepared");
  assert.equal(goMethodName("_1st"), "Action1st");
});

test("--go writes only the Go adapter, embedding the artifact beside it", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, twoPhaseCommitModel);
    writeGoModule(directory);

    const result = compileProject("model.qnt", {
      cwd: directory,
      artifact: "adapter/traces.json",
      go: "adapter/generated.go",
    });

    assert.equal(result.generatedRustPath, undefined);
    assert.equal(fs.existsSync(path.join(directory, "src")), false, "no Rust scaffold for a Go project");
    const go = fs.readFileSync(path.join(directory, "adapter", "generated.go"), "utf8");
    assert.match(go, /^\/\/ Code generated by quint-refinements from model\.qnt\. DO NOT EDIT\.$/m);
    assert.match(go, /^package adapter$/m, "the package defaults to the adapter's directory");
    assert.match(go, /^\/\/go:embed traces\.json$/m);
    assert.match(go, /Refines:\s+\[\]string\{"prepare", "flushWal", "commitPrepared"\}/);
    assert.match(go, /Commit\(actions \[\]refinements\.ResolvedAction\) \(\[\]refinements\.Evidence, error\)/);
    assert.match(go, /Begin\(arguments \[\]refinements\.RuntimeValue\) error/);
    assert.doesNotMatch(go, /FlushWal/, "the actions a @primitive owns have no method of their own");
    assert.match(go, /func RefineAll\[I Implementation\]\(/);
  });
});

test("--go and --rust together write both adapters from one artifact", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);

    compileProject("model.qnt", {
      cwd: directory,
      artifact: "both/traces.json",
      rust: "both/generated.rs",
      go: "both/generated.go",
      goPackage: "bank",
    });

    assert.match(fs.readFileSync(path.join(directory, "both", "generated.rs"), "utf8"), /include_str!\("traces\.json"\)/);
    assert.match(fs.readFileSync(path.join(directory, "both", "generated.go"), "utf8"), /^package bank$/m);
    compileProject("model.qnt", {
      cwd: directory,
      artifact: "both/traces.json",
      rust: "both/generated.rs",
      go: "both/generated.go",
      goPackage: "bank",
      check: true,
    });
  });
});

test("the generated Go adapter compiles and an unimplemented method is a compile error", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, twoPhaseCommitModel);
    writeGoModule(directory);
    compileProject("model.qnt", { cwd: directory, artifact: "traces.json", go: "generated.go", goPackage: "adapter" });
    const vet = () => spawnSync("go", ["vet", "./..."], { cwd: directory, encoding: "utf8" });

    assert.equal(vet().status, 0, vet().stderr);

    fs.writeFileSync(path.join(directory, "impl.go"), `package adapter

import refinements "github.com/ArchAstro/quint-refinements/bindings/go"

type impl struct{}

func (impl) Snapshot() refinements.Evidence { return nil }
func (impl) Begin([]refinements.RuntimeValue) error { return nil }
func (impl) Abort([]refinements.RuntimeValue) error { return nil }

var _ Implementation = impl{}
`);
    const missing = vet();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing method Commit/);
  });
});

test("--check covers the Go adapter", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    const options = { cwd: directory, go: "generated.go", goPackage: "bank" };
    compileProject("model.qnt", options);
    compileProject("model.qnt", { ...options, check: true });

    const generated = path.join(directory, "generated.go");
    fs.writeFileSync(generated, `${fs.readFileSync(generated, "utf8")}// edited by hand\n`);
    assert.throws(
      () => compileProject("model.qnt", { ...options, check: true }),
      /generated\.go drifted; run quint-refinements compile/,
    );
  });
});

test("Go rejects an artifact it cannot embed and an invalid package name", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory, go: "adapter/generated.go" }),
      /go:embed cannot reach outside the package directory/,
    );
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory, go: "generated.go", goPackage: "Not-A-Package" }),
      /--go-package Not-A-Package is not a valid Go package name/,
    );
  });
});

test("Go-only projects may name an action after a Rust keyword, but not after Snapshot", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel.replaceAll("withdraw", "move"));
    compileProject("model.qnt", { cwd: directory, go: "generated.go", goPackage: "bank" });
    assert.match(fs.readFileSync(path.join(directory, "generated.go"), "utf8"), /Move\(arguments \[\]refinements\.RuntimeValue\) error/);
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory }),
      /move maps to reserved Rust name move/,
    );

    writeModel(directory, bankModel.replaceAll("withdraw", "snapshot"));
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory, go: "generated.go", goPackage: "bank" }),
      /snapshot maps to reserved Go method Snapshot/,
    );
  });
});

const typescriptBinary = path.join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

// A project that resolves `quint-refinements/runtime` to this checkout, the way
// a user's node_modules would, so a generated adapter can be type-checked.
function writeTypescriptProject(directory) {
  const modules = path.join(directory, "node_modules");
  fs.mkdirSync(modules);
  fs.symlinkSync(repositoryRoot, path.join(modules, "quint-refinements"), "dir");
  fs.symlinkSync(path.join(repositoryRoot, "node_modules", "@types"), path.join(modules, "@types"), "dir");
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noUncheckedIndexedAccess: true,
      noUnusedLocals: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node"],
    },
    include: ["*.ts"],
  }));
}

function typecheck(directory) {
  return spawnSync(typescriptBinary, ["-p", directory], { encoding: "utf8" });
}

test("TypeScript method names are camelCase and agree for snake and camel case", () => {
  assert.equal(typescriptMethodName("withdraw"), "withdraw");
  assert.equal(typescriptMethodName("flushWal"), "flushWal");
  assert.equal(typescriptMethodName("flush_wal"), "flushWal");
  assert.equal(typescriptMethodName("CommitPrepared"), "commitPrepared");
  assert.equal(typescriptMethodName("_1st"), "action1st");
});

test("--typescript writes only the TypeScript adapter and reads the artifact from beside it", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, twoPhaseCommitModel);

    const result = compileProject("model.qnt", {
      cwd: directory,
      artifact: "adapter/traces.json",
      typescript: "adapter/generated.ts",
    });

    assert.equal(result.generatedRustPath, undefined);
    assert.equal(fs.existsSync(path.join(directory, "src")), false, "no Rust scaffold for a TypeScript project");
    const source = fs.readFileSync(path.join(directory, "adapter", "generated.ts"), "utf8");
    assert.match(source, /^\/\/ @generated by quint-refinements from model\.qnt\. Do not edit\.$/m);
    assert.match(source, /from "quint-refinements\/runtime";/);
    assert.match(source, /new URL\("traces\.json", import\.meta\.url\)/);
    assert.match(source, /refines: \["prepare", "flushWal", "commitPrepared"\],/);
    assert.match(source, /commit\(actions: readonly ResolvedAction\[\]\): readonly Evidence\[\];/);
    assert.match(source, /begin\(args: readonly RuntimeValue\[\]\): void;/);
    assert.doesNotMatch(source, /flushWal\(/, "the actions a @primitive owns have no method of their own");
    assert.match(source, /export async function refineAll</);
    assert.match(source, /export function refineAllSync</);
  });
});

test("the TypeScript adapter may live anywhere relative to its artifact", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    compileProject("model.qnt", { cwd: directory, artifact: "data/traces.json", typescript: "src/adapter/generated.ts" });
    assert.match(
      fs.readFileSync(path.join(directory, "src", "adapter", "generated.ts"), "utf8"),
      /new URL\("\.\.\/\.\.\/data\/traces\.json", import\.meta\.url\)/,
    );
  });
});

test("--typescript, --go and --rust together write all three adapters from one artifact", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    const options = {
      cwd: directory,
      artifact: "all/traces.json",
      rust: "all/generated.rs",
      go: "all/generated.go",
      goPackage: "bank",
      typescript: "all/generated.ts",
    };
    compileProject("model.qnt", options);
    for (const file of ["traces.json", "generated.rs", "generated.go", "generated.ts"]) {
      assert.equal(fs.existsSync(path.join(directory, "all", file)), true, file);
    }
    compileProject("model.qnt", { ...options, check: true });
  });
});

test("--check covers the TypeScript adapter", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel);
    const options = { cwd: directory, typescript: "generated.ts" };
    compileProject("model.qnt", options);
    compileProject("model.qnt", { ...options, check: true });

    const generated = path.join(directory, "generated.ts");
    fs.writeFileSync(generated, `${fs.readFileSync(generated, "utf8")}// edited by hand\n`);
    assert.throws(
      () => compileProject("model.qnt", { ...options, check: true }),
      /generated\.ts drifted; run quint-refinements compile/,
    );
    fs.rmSync(generated);
    assert.throws(
      () => compileProject("model.qnt", { ...options, check: true }),
      /generated\.ts drifted; run quint-refinements compile/,
    );
  });
});

test("the generated TypeScript adapter type-checks and an unimplemented method is a compile error", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, twoPhaseCommitModel);
    writeTypescriptProject(directory);
    compileProject("model.qnt", { cwd: directory, typescript: "generated.ts" });
    // The adapter needs the built runtime declarations, as a published package would ship them.
    assert.equal(spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "build-runtime.mjs")], { encoding: "utf8" }).status, 0);

    const complete = typecheck(directory);
    assert.equal(complete.status, 0, complete.stdout);

    fs.writeFileSync(path.join(directory, "impl.ts"), `import type { Evidence } from "quint-refinements/runtime";
import type { Implementation } from "./generated.ts";

export const impl: Implementation = {
  snapshot: (): Evidence => ({ resolveName: () => undefined }),
  begin: () => {},
  abort: () => {},
};
`);
    const missing = typecheck(directory);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /Property 'commit' is missing/);

    const implementation = `import type { Evidence } from "quint-refinements/runtime";
import { refineAll, type Implementation } from "./generated.ts";

export class Impl implements Implementation {
  snapshot(): Evidence { return { resolveName: () => undefined }; }
  begin(): void {}
  abort(): void {}
  commit(): readonly Evidence[] { return []; }
}
export { refineAll };
`;
    // An implementation whose methods return promises is accepted by refineAll.
    fs.writeFileSync(path.join(directory, "impl.ts"), `${implementation}
class Async {
  snapshot = async (): Promise<Evidence> => ({ resolveName: () => undefined });
  begin = async (): Promise<void> => {};
  abort = async (): Promise<void> => {};
  commit = async (): Promise<readonly Evidence[]> => [];
}
await refineAll(() => new Async());
await refineAll(() => new Impl());
`);
    const asynchronous = typecheck(directory);
    assert.equal(asynchronous.status, 0, asynchronous.stdout);

    // A method with the wrong result type is a compile error.
    fs.writeFileSync(path.join(directory, "impl.ts"), `${implementation}
export class Wrong extends Impl {
  override commit(): string { return "done"; }
}
`);
    const wrong = typecheck(directory);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stdout, /Property 'commit' in type 'Wrong' is not assignable to the same property in base type 'Impl'/);
  });
});

test("TypeScript allows an action named after a Rust keyword, but not after a name an object cannot give up", () => {
  withTemporaryDirectory(directory => {
    writeModel(directory, bankModel.replaceAll("withdraw", "delete"));
    compileProject("model.qnt", { cwd: directory, typescript: "generated.ts" });
    assert.match(fs.readFileSync(path.join(directory, "generated.ts"), "utf8"), /delete\(args: readonly RuntimeValue\[\]\): void;/);

    for (const name of ["snapshot", "toString", "constructor"]) {
      writeModel(directory, bankModel.replaceAll("withdraw", name));
      assert.throws(
        () => compileProject("model.qnt", { cwd: directory, typescript: "generated.ts" }),
        new RegExp(`${name} maps to reserved TypeScript method ${name}`),
      );
    }
  });
});

test("two actions that map to one TypeScript method are rejected", () => {
  withTemporaryDirectory(directory => {
    const model = bankModel.replace(/\n  \/\/\/ @conformance[\s\S]*$/, `
  action flush_wal = all { state.balance >= 0, state' = state }
  action flushWal = all { state.balance >= 0, state' = state }

  /// @conformance
  run both = init.then(flush_wal).then(flushWal)
}
`);
    writeModel(directory, model);
    assert.throws(
      () => compileProject("model.qnt", { cwd: directory, typescript: "generated.ts" }),
      /flush_wal and flushWal both map to TypeScript method flushWal/,
    );
  });
});
