import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compileProject, createProject } from "./cli.mjs";

const compilerRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(compilerRoot, "..", "..");
const rustBindingRoot = path.join(repositoryRoot, "bindings", "rust");

test("new and compile derive the integration from the Quint AST", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-cli-test-"));
  try {
    const projectDirectory = createProject("bank-refinement", {
      cwd: temporaryRoot,
      install: false,
    });
    const bankModel = fs.readFileSync(
      path.join(repositoryRoot, "examples", "rust", "bank_account", "bank.qnt"),
      "utf8",
    )
      .replace(
        "  /// @conformance requires = [bank.withdraw]",
        `  def expectedBalance: bool = state.balance == 6

  /// @conformance requires = [bank.withdraw]`,
      )
      .replace("assert(state.balance == 6)", "assert(expectedBalance)")
      .replace(/\n}\s*$/, `

  // Ordinary Quint runs do not become refinement scenarios.
  run exploratory = init.then(withdraw(1))
}
`);
    fs.writeFileSync(path.join(projectDirectory, "model.qnt"), bankModel);

    const result = compileProject("model.qnt", { cwd: projectDirectory });

    assert.equal(result.project.module, "bank");
    assert.deepEqual(result.project.actions, ["withdraw"]);
    assert.deepEqual(result.project.stateVariables, ["state"]);
    assert.ok(fs.existsSync(path.join(projectDirectory, "quint-refinements.json")));
    const artifact = JSON.parse(
      fs.readFileSync(path.join(projectDirectory, "quint-refinements.json"), "utf8"),
    );
    assert.deepEqual(artifact.scenarios.map(scenario => scenario.name), ["withdrawRun"]);
    assert.doesNotMatch(JSON.stringify(artifact), /name:expectedBalance/);
    assert.match(
      fs.readFileSync(path.join(projectDirectory, "src", "generated_refinement.rs"), "utf8"),
      /fn withdraw\(&mut self, arguments: &\[RuntimeValue\]\)/,
    );
    assert.match(
      fs.readFileSync(path.join(projectDirectory, "src", "main.rs"), "utf8"),
      /implement Quint action withdraw/,
    );
    assert.equal(fs.existsSync(path.join(projectDirectory, "app-config.mjs")), false);
    assert.equal(fs.existsSync(path.join(projectDirectory, "generate-traces.mjs")), false);

    compileProject("model.qnt", { cwd: projectDirectory, check: true });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the generated starter project compiles as Rust before domain hooks are implemented", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-new-test-"));
  try {
    const projectDirectory = createProject("counter-refinement", {
      cwd: temporaryRoot,
      install: false,
    });
    compileProject("model.qnt", { cwd: projectDirectory });

    const manifestPath = path.join(projectDirectory, "Cargo.toml");
    const manifest = fs.readFileSync(manifestPath, "utf8").replace(
      'quint-refinements = "0.1.0"',
      `quint-refinements = { path = ${JSON.stringify(rustBindingRoot)} }`,
    );
    fs.writeFileSync(manifestPath, manifest);

    const cargo = spawnSync("cargo", ["check", "--manifest-path", manifestPath], {
      encoding: "utf8",
    });
    assert.equal(cargo.status, 0, cargo.stderr);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the npm-style symlink invokes the CLI entrypoint", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-bin-test-"));
  try {
    const binaryPath = path.join(temporaryRoot, "quint-refinements");
    fs.symlinkSync(path.join(compilerRoot, "cli.mjs"), binaryPath);

    const invocation = spawnSync(binaryPath, ["--help"], { encoding: "utf8" });

    assert.equal(invocation.status, 0, invocation.stderr);
    assert.match(invocation.stdout, /quint-refinements compile <spec\.qnt>/);
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
        'import("@archastro/quint-refinements/harness/generate.mjs")',
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
    const compiled = spawnSync(binary, ["compile", "counter/model.qnt"], {
      cwd: consumerDirectory,
      encoding: "utf8",
    });
    assert.equal(compiled.status, 0, compiled.stderr);

    // Observable outcome: the consumer receives every generated Rust boundary artifact.
    assert.ok(fs.existsSync(path.join(consumerDirectory, "counter", "quint-refinements.json")));
    assert.ok(fs.existsSync(
      path.join(consumerDirectory, "counter", "src", "generated_refinement.rs"),
    ));
    assert.ok(fs.existsSync(path.join(consumerDirectory, "counter", "src", "main.rs")));

    // Rust boundary: compile the packed CLI's generated project against this checkout's
    // matching runtime version, avoiding a registry dependency before the first release.
    const manifestPath = path.join(consumerDirectory, "counter", "Cargo.toml");
    const manifest = fs.readFileSync(manifestPath, "utf8").replace(
      'quint-refinements = "0.1.0"',
      `quint-refinements = { path = ${JSON.stringify(rustBindingRoot)} }`,
    );
    fs.writeFileSync(manifestPath, manifest);
    const cargo = spawnSync("cargo", ["check", "--manifest-path", manifestPath], {
      encoding: "utf8",
    });
    assert.equal(cargo.status, 0, cargo.stderr);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
