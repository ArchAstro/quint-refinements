#!/usr/bin/env node

// Regenerates, or with --check verifies, every checked-in file this repository
// derives from a Quint model: the example adapters and the binding corpus.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileProject } from "../packages/compiler/cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.slice(2).includes("--check");
const unexpected = process.argv.slice(2).filter(argument => argument !== "--check");
if (unexpected.length > 0) {
  throw new Error(`unsupported arguments: ${unexpected.join(" ")}`);
}

const models = [
  {
    source: "examples/rust/bank_account/bank.qnt",
    corpusCase: "bank_withdraw",
  },
  {
    source: "examples/go/bank_account/bank.qnt",
    go: "examples/go/bank_account/generated_refinement.go",
    goPackage: "main",
  },
  {
    source: "examples/rust/raft/model.qnt",
    artifact: "examples/go/raft/quint-refinements.json",
    go: "examples/go/raft/generated_refinement.go",
    goPackage: "main",
  },
  {
    source: "examples/rust/raft_network/model.qnt",
    artifact: "examples/go/raft_network/quint-refinements.json",
    go: "examples/go/raft_network/generated_refinement.go",
    goPackage: "main",
  },
  {
    source: "examples/typescript/bank_account/bank.qnt",
    typescript: "examples/typescript/bank_account/generated_refinement.ts",
  },
  {
    source: "examples/typescript/two_phase_commit/model.qnt",
    typescript: "examples/typescript/two_phase_commit/generated_refinement.ts",
  },
  {
    source: "examples/rust/raft/model.qnt",
    artifact: "examples/typescript/raft/quint-refinements.json",
    typescript: "examples/typescript/raft/generated_refinement.ts",
  },
  {
    source: "examples/rust/shop_orders/model.qnt",
  },
  {
    source: "examples/rust/transaction_commit/model.qnt",
  },
  {
    source: "examples/rust/raft/model.qnt",
  },
  {
    source: "examples/rust/raft_network/model.qnt",
  },
  {
    source: "bindings/rust/examples/two_phase_commit/model.qnt",
    artifact: "bindings/rust/examples/two_phase_commit/traces.json",
    rust: "bindings/rust/examples/two_phase_commit/generated.rs",
    corpusCase: "two_phase_commit",
  },
  {
    source: "bindings/rust/examples/two_phase_commit/model.qnt",
    artifact: "bindings/go/examples/two_phase_commit/traces.json",
    go: "bindings/go/examples/two_phase_commit/generated.go",
    goPackage: "twophasecommit",
  },
];

for (const { source, artifact, rust, go, goPackage, typescript, corpusCase } of models) {
  const { artifactPath } = compileProject(source, { cwd: root, artifact, rust, go, goPackage, typescript, check });
  if (corpusCase) {
    const generated = fs.readFileSync(artifactPath, "utf8");
    const corpusPath = path.join(root, "conformance", "cases", corpusCase, "artifact.json");
    if (!check) {
      fs.writeFileSync(corpusPath, generated);
    } else if (fs.readFileSync(corpusPath, "utf8") !== generated) {
      throw new Error(`conformance case ${corpusCase} drifted; run npm run generate`);
    }
  }
  console.log(`${check ? "current" : "generated"}: ${source}`);
}
