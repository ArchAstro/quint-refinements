#!/usr/bin/env node

// Proves the packed npm tarball works the way a user installs it: unpack it
// into a project's node_modules, compile a model to a TypeScript adapter with
// the packed CLI, type-check an implementation against `quint-refinements/runtime`
// and run it. Usage: node scripts/check-package.mjs <quint-refinements-x.y.z.tgz>

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarball = process.argv[2];
if (!tarball) {
  throw new Error("usage: node scripts/check-package.mjs <quint-refinements-x.y.z.tgz>");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: command.endsWith(".cmd") });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const project = fs.mkdtempSync(path.join(os.tmpdir(), "quint-refinements-package-"));
try {
  const modules = path.join(project, "node_modules");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module" }));
  // The quint compiler is a bundled dependency, so this needs no registry.
  run(npm, ["install", "--offline", "--no-audit", "--no-fund", path.resolve(tarball)], project);
  // TypeScript and the Node typings are the user's own dependencies, not the package's.
  fs.symlinkSync(path.join(root, "node_modules", "typescript"), path.join(modules, "typescript"), "dir");
  fs.symlinkSync(path.join(root, "node_modules", "@types"), path.join(modules, "@types"), "dir");

  fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true,
      noUncheckedIndexedAccess: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"],
    },
    include: ["*.ts"],
  }));
  fs.copyFileSync(path.join(root, "examples", "typescript", "bank_account", "bank.qnt"), path.join(project, "bank.qnt"));

  const cli = path.join(modules, "quint-refinements", "packages", "compiler", "cli.mjs");
  run(process.execPath, [cli, "compile", "bank.qnt", "--typescript", "generated.ts"], project);
  fs.writeFileSync(path.join(project, "main.ts"), `import { int, record, stateEvidence, asInt, type RuntimeValue } from "quint-refinements/runtime";
import { refineAllSync, type Implementation } from "./generated.ts";

class Bank implements Implementation {
  balance = 10;
  snapshot() { return stateEvidence(record({ balance: int(this.balance) })); }
  withdraw(args: readonly RuntimeValue[]): void { this.balance -= Number(asInt(args[0])); }
}

const [result] = refineAllSync(() => new Bank());
console.log(\`\${result?.scenario} refined \${result?.evaluatedObligations} obligations\`);
`);
  run(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), ["-p", project], project);
  const output = run(process.execPath, ["main.ts"], project);
  if (!output.includes("bank.withdrawRun refined 3 obligations")) {
    throw new Error(`unexpected output from the packed runtime: ${output}`);
  }
  console.log(`${path.basename(tarball)}: ${output.trim()}`);
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
