import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compileProject, createProject } from "./cli.mjs";
import { defineConformanceApp, generateConformanceTraces } from "./generate.mjs";

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
