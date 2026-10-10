# Documentation site

The site at <https://archastro.github.io/quint-refinements/> is built with [VitePress](https://vitepress.dev) from the Markdown in [`../docs`](../docs). Write documentation there; it reads the same on GitHub and on the site.

```console
cd website
npm ci
npm run dev      # live preview at http://localhost:5173/quint-refinements/
npm run build    # what CI runs
```

| Path | Contents |
|---|---|
| `index.md` | The home page, the only page that lives here |
| `docs` | A symlink to `../docs` |
| `.vitepress/config.mjs` | Navigation, sidebar, link handling |
| `.vitepress/quint.tmLanguage.json` | Quint syntax highlighting |
| `.vitepress/theme/` | Colors and the home page terminal |

Adding a page: create the Markdown file in `docs/`, then add it to `sidebar` in `.vitepress/config.mjs`.

Links from a page to a file outside `docs/` (an example, a source file) are written as relative paths, so they work on GitHub; the site points them at the repository.

The `Docs` workflow builds the site on every pull request that touches it and publishes from `main`.
