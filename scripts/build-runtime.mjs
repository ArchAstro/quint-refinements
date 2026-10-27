#!/usr/bin/env node

// Builds the TypeScript runtime into bindings/typescript/dist, which the
// package ships as `quint-refinements/runtime`. The directory is removed first
// so a renamed or deleted module never lingers in the published package.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "bindings", "typescript");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

fs.rmSync(path.join(runtime, "dist"), { recursive: true, force: true });
const result = spawnSync(tsc, ["-p", path.join(runtime, "tsconfig.build.json")], { stdio: "inherit", shell: process.platform === "win32" });
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
