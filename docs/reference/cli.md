# Command line

```text
quint-refinements new <project-name> [--no-install]
quint-refinements compile [spec.qnt] [--check] [--module <name>]
                          [--artifact <path>] [--rust <path>]
quint-refinements --version
quint-refinements --help
```

Run it with `npx quint-refinements`, or through the `compile` and `check` scripts a new project has in `package.json`.

## `new`

```console
npx quint-refinements new my-check
```

Creates a directory with a model, a Rust implementation of it and the generated files between them. The project refines as created: `cargo run` passes.

| File | Contents |
|---|---|
| `model.qnt` | A counter model with one `@conformance` run |
| `src/main.rs` | A working `Counter` implementation |
| `quint-refinements.json` | Generated scenarios |
| `src/generated_refinement.rs` | Generated trait and runner |
| `Cargo.toml` | Depends on the `quint-refinements` crate at the compiler's version |
| `package.json` | Pins the compiler; scripts `compile` and `check` |

| Option | Meaning |
|---|---|
| `--no-install` | Skip `npm install` in the new project. |

The name must use lowercase letters, numbers and hyphens, and the directory must not exist.

## `compile`

```console
npx quint-refinements compile
```

Reads the model, runs each `@conformance` scenario through Quint, and writes two files:

1. `quint-refinements.json`: the scenarios and their obligations.
2. `src/generated_refinement.rs`: the `Implementation` trait, ownership records and runner.

Both are replaced on every run. `src/main.rs` is written only when it does not exist.

| Argument | Default | Meaning |
|---|---|---|
| `spec.qnt` | `model.qnt` | The model to compile. Generated files go beside it. |
| `--check` | off | Write nothing. Fail if a generated file differs from what the model produces. |
| `--module <name>` | the only module with scenarios | Which module to compile when several declare `@conformance` runs. |
| `--artifact <path>` | `quint-refinements.json` | Where the scenario file goes. |
| `--rust <path>` | `src/generated_refinement.rs` | Where the Rust module goes. With this flag `src/main.rs` is not scaffolded. |

### Output

```text
generated quint-refinements.json and src/generated_refinement.rs
```

With `--check`, when everything is current:

```text
counter generated artifacts are current
```

and when it is not, with exit status 1:

```text
quint-refinements.json drifted; run quint-refinements compile
```

### Requirements

1. Node.js 22 or newer. Quint ships inside the package; you do not install it separately.
2. `rustfmt` on the `PATH`, because the generated Rust is formatted (`rustup component add rustfmt`).

## Versions

The npm package and the Rust crate release together under one version number. Keep `quint-refinements` in `package.json` and in `Cargo.toml` on the same version.

See also: [keeping generated files honest in CI](../guides/ci.md) and [troubleshooting](../troubleshooting.md).
