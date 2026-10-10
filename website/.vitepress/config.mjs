import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

// The site renders the Markdown in ../docs unchanged, so the same files read
// well on GitHub and here. Only the home page (index.md) lives in this folder.
const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const docsRoot = path.join(repositoryRoot, "docs");
const repository = "https://github.com/ArchAstro/quint-refinements";
const site = "https://archastro.github.io/quint-refinements/";
const description =
  "Check that your real code does what your Quint model says. Generated scenarios, typed Rust adapters and refinement checks.";
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
).version;
const quint = JSON.parse(
  fs.readFileSync(path.join(websiteRoot, ".vitepress", "quint.tmLanguage.json"), "utf8"),
);

/// Point links that leave docs/ (examples, source files) at GitHub, and links
/// to the GitHub-only docs index at the home page.
function repositoryLinks(md) {
  md.core.ruler.push("repository-links", state => {
    // `realPath` is the source file when a rewrite moved the page.
    const source = state.env.realPath ?? state.env.path;
    if (!source) {
      return;
    }
    const page = fs.realpathSync(source);
    const visit = tokens => {
      for (const token of tokens) {
        if (token.children) {
          visit(token.children);
        }
        const href = token.type === "link_open" ? token.attrGet("href") : null;
        if (!href || /^([a-z]+:|#|\/)/i.test(href)) {
          continue;
        }
        const [target, fragment] = href.split("#");
        const resolved = path.resolve(path.dirname(page), target);
        const anchor = fragment ? `#${fragment}` : "";
        if (resolved === path.join(docsRoot, "README.md")) {
          token.attrSet("href", `/${anchor}`);
        } else if (path.relative(docsRoot, resolved).startsWith("..")) {
          const kind = fs.statSync(resolved).isDirectory() ? "tree" : "blob";
          const relative = path.relative(repositoryRoot, resolved).split(path.sep).join("/");
          token.attrSet("href", `${repository}/${kind}/main/${relative}${anchor}`);
        }
      }
    };
    visit(state.tokens);
  });
}

/// Heading anchors the way GitHub writes them, so `page.md#section` links in
/// the Markdown work in both places.
function githubSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export default defineConfig({
  lang: "en-US",
  title: "quint-refinements",
  description,
  base: "/quint-refinements/",
  cleanUrls: true,
  lastUpdated: true,

  // `docs` here is a symlink to ../docs. Keeping the link (instead of resolving
  // it) lets those pages find this folder's dependencies.
  srcExclude: ["README.md", "docs/README.md"],
  rewrites: { "docs/:path(.*)": ":path" },
  vite: {
    resolve: { preserveSymlinks: true },
  },
  sitemap: { hostname: site },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/quint-refinements/logo.svg" }],
    ["meta", { name: "theme-color", content: "#6d43f5" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "quint-refinements" }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { property: "og:url", content: site }],
  ],

  markdown: {
    languages: [quint],
    anchor: { slugify: githubSlug },
    theme: { light: "github-light", dark: "github-dark-dimmed" },
    config: repositoryLinks,
  },

  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Tutorial", link: "/tutorial", activeMatch: "^/tutorial" },
      { text: "Guides", link: "/guides/shop-orders", activeMatch: "^/guides/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "^/reference/" },
      { text: "How it works", link: "/how-it-works", activeMatch: "^/how-it-works" },
      {
        text: `v${packageVersion}`,
        items: [
          { text: "Changelog", link: `${repository}/blob/main/CHANGELOG.md` },
          { text: "npm", link: "https://www.npmjs.com/package/quint-refinements" },
          { text: "crates.io", link: "https://crates.io/crates/quint-refinements" },
          { text: "Rust API (docs.rs)", link: "https://docs.rs/quint-refinements" },
          { text: "Contributing", link: `${repository}/blob/main/CONTRIBUTING.md` },
        ],
      },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Quick start", link: "/quick-start" },
          { text: "Tutorial: a bank account", link: "/tutorial" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Constants, branching, two files", link: "/guides/shop-orders" },
          { text: "One command, several actions", link: "/guides/one-command-many-actions" },
          { text: "Keep generated files honest in CI", link: "/guides/ci" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Command line", link: "/reference/cli" },
          { text: "Model annotations and rules", link: "/reference/model" },
          { text: "Generated Rust", link: "/reference/rust" },
        ],
      },
      {
        text: "Understand",
        items: [
          { text: "How it works", link: "/how-it-works" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
      {
        text: "Examples",
        items: [
          { text: "bank_account", link: `${repository}/tree/main/examples/rust/bank_account` },
          { text: "shop_orders", link: `${repository}/tree/main/examples/rust/shop_orders` },
          {
            text: "transaction_commit",
            link: `${repository}/tree/main/examples/rust/transaction_commit`,
          },
        ],
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
    editLink: {
      // Serialized into the client bundle, so it cannot close over `repository`.
      pattern: ({ filePath }) =>
        `https://github.com/ArchAstro/quint-refinements/edit/main/${
          filePath === "index.md" ? "website/index.md" : filePath
        }`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 ArchAstro",
    },
  },
});
