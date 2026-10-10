import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const docsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(docsRoot, "..");

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(entryPath);
    }
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

const pages = [path.join(repositoryRoot, "README.md"), ...markdownFiles(docsRoot)];

test("code quoted from an example is the code CI compiles", () => {
  // A block introduced by `<!-- from path -->` must appear verbatim in that file.
  const quoted = /<!-- from (\S+) -->\n```\w*\n([\s\S]*?)\n```/g;
  let checked = 0;
  for (const page of pages) {
    for (const [, source, code] of fs.readFileSync(page, "utf8").matchAll(quoted)) {
      const actual = fs.readFileSync(path.join(repositoryRoot, source), "utf8");
      assert.ok(
        actual.includes(code),
        `${path.relative(repositoryRoot, page)} quotes ${source}, but this block is not in it:\n${code}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 10, `expected the guides to quote their examples; found ${checked} blocks`);
});

test("relative links point at files that exist", () => {
  const link = /\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g;
  for (const page of pages) {
    for (const [, target] of fs.readFileSync(page, "utf8").matchAll(link)) {
      const resolved = path.resolve(path.dirname(page), target);
      assert.ok(
        fs.existsSync(resolved),
        `${path.relative(repositoryRoot, page)} links to missing ${target}`,
      );
    }
  }
});

test("links to a section name a heading that exists", () => {
  // GitHub's heading anchors; the documentation site is configured to match.
  const slug = heading =>
    heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const link = /\]\((?!https?:|mailto:)([^)#\s]*)#([^)\s]+)\)/g;
  for (const page of pages) {
    for (const [, target, fragment] of fs.readFileSync(page, "utf8").matchAll(link)) {
      const resolved = target ? path.resolve(path.dirname(page), target) : page;
      if (!resolved.endsWith(".md")) {
        continue;
      }
      const headings = [...fs.readFileSync(resolved, "utf8").matchAll(/^#+ (.*)$/gm)]
        .map(([, heading]) => slug(heading));
      assert.ok(
        headings.includes(fragment),
        `${path.relative(repositoryRoot, page)} links to missing section #${fragment} in ${target || "itself"}`,
      );
    }
  }
});
