# Operations: harness, CI, pins, size, load

## 1. A harness script

Once a model has more than a few checks, put them in one script (`check-model`) so every run is the same.

Order:

1. Typecheck each module.
2. Run every scenario with `--max-samples=1` and an exact `--match`, and assert the passing count.
3. Random search of `safety` with a fixed seed.
4. Witnesses: each must be violated.
5. Broken variants: each must be caught by its own invariant or scenario.
6. Exhaustive checks, if any.
7. `quint-refinements compile --check`, and a comparison of the artifact's scenario names with the script's list.

Practices:

1. Decide pass or fail from output markers, not exit codes. See [quint-gotchas.md](quint-gotchas.md#2-verdicts).
2. Write each call's output to a log in a temporary directory and print the directory.
3. Fixed seeds everywhere. State in the header that random runs are evidence, not proof.
4. Fail if any definition outside the scenario file is named `...Run`.
5. Give the script flags to run a subset (`--only=typecheck,scenarios`) and to regenerate (`--generate`).
6. Run independent Quint calls in a small pool (three or four). Typecheck alone costs seconds per module, so dozens of serial calls add up to many minutes. Keep `quint verify` calls serial or give each its own port, and cap the pool for memory when JVMs are involved.
7. Install the Rust evaluator once before the pool starts.
8. Test the script with a fake `quint` executable: it must report a missing verdict as a failure.

## 2. CI

Three kinds of check can run in CI, and they cost very different amounts.

| Check | Cost | Needs |
|---|---|---|
| The replay: the language's own test reading the committed artifact | Seconds to a few minutes | The language toolchain only |
| `compile --check` | Seconds to minutes; runs every scenario through Quint | Node.js, and the formatter for the target language |
| Random search, witnesses, variants, exhaustive checks | Minutes to hours | Quint, the Rust evaluator, Java for `verify` |

1. Always run the replay on every pull request. It needs no Quint.
2. Run `compile --check` on pull requests if you can afford Node.js and Quint there. See the [CI guide](https://github.com/ArchAstro/quint-refinements/blob/main/docs/guides/ci.md). Cache `~/.quint`.
3. Keep long searches out of pull-request CI. They grow with the model, from minutes to hours, they fail for reasons unrelated to the change (rate limits, port clashes, install races), and they hold up every other change. Run them locally before pushing and in a scheduled or manually triggered job.
4. If the team keeps Quint out of CI entirely, nothing automatic catches a stale artifact. Regenerating, running `--check` and committing the generated files is then a required step of every model change, and the project README must name the command.
5. A generated file that conflicts in a merge or rebase is resolved by regenerating from the merged model, never by editing the file.
6. If the build system selects tests by changed files, make a model change select the replay test. A model-only change that does not re-run the replay is a gap.
7. Format before `--check`, then `--check` again. A formatter that rewrites a generated file makes it stale. Exclude generated files from the formatter if needed.

## 3. Version pins

1. The compiler and the runtime for your language release together. Pin both to the same version or the same commit.
2. If you need an unreleased fix, pin a commit on `main`, never a commit on a pull-request branch. A squash merge orphans the branch commit.
3. With npm, a `github:` dependency can resolve to an SSH URL in the lockfile. A tarball URL for the commit avoids that.
4. A project with adapters in several languages has several pins. Move them together, and after every bump re-run every consumer: each model check, each replay, each `--check`.
5. A pin bump can make passing tests fail when the newer runtime checks more. That is the tests having been weaker than they looked (see whole maps in [adapters.md](adapters.md#3-snapshots)). Fix the adapters; do not hold the pin back.
6. The artifact has a schema version. An older runtime cannot read a newer artifact. Keep compiler and runtimes on versions that agree, not a conversion shim.
7. Read the changelog before reshaping a model around a tool limit. The limit may already be fixed.
8. A model goes stale when code changes merge without it. If several changes to the modelled code are in flight, each one updates the model, or the replay turns the main branch red after they land.
9. Check that an API exists at the pinned version before calling it or proposing to change it.

## 4. Artifact size

The artifact holds every state of every scenario, plus every obligation.

1. Size grows with the number of state fields times the number of steps. Models have reached hundreds of megabytes, which breaks JavaScript's maximum string length at compile time, exhausts the heap at test time, and exceeds a repository host's file limit.
2. Use a compiler version with schema version 3, which stores each distinct obligation list once. On a model with many scenarios this cuts the file several times over.
3. Pass `--compact` (to `--check` as well).
4. Bind a value used twice once, so it is not inlined twice. See [modeling.md](modeling.md#3-actions).
5. Keep property-only history out of `state`.
6. If the artifact is still large, commit it compressed and have the test decompress it. Compare decompressed content in drift checks, because compressed bytes vary across library versions.
7. Parse the artifact once per test process.
8. To raise Node's heap for a test, pass `--max-old-space-size` on the command line. `NODE_OPTIONS` does not always reach test-runner child processes.
9. The model digest covers every `.qnt` file in the model's directory (not subdirectories). Editing any one of them makes every artifact compiled from that directory stale. Keep unrelated models in separate directories.
10. Watch the size in review. A file that doubles after a small model change points at an inlining problem.

## 5. Machine load

1. `quint run` with a large sample count uses every core. An exhaustive check with a large heap does the same.
2. Size the sample count to the question. 50,000 short traces answer most safety questions on a small model.
3. Run long sweeps at low priority (`nice`), and not while other builds or agents share the machine.
4. Never leave a loop that re-runs searches after your session ends. Check for stray processes (`pgrep -fl "quint"`) before starting more, and stop your own when done.
5. Exporting many long traces at once can exhaust Node's heap. Export in batches.

## 6. Layout and housekeeping

1. Generated files are committed, start with a generated marker, and are never edited. Exclude them from lint.
2. The README for a model has: the action-to-function table, the invariants, the variant table, the production mutations, the commands to check and regenerate, and the limits.
3. Split a large change into a model change and a code change, model first, and say which merges first.
4. `quint-refinements` is a public repository. An issue or pull request there carries a minimal model and the message, not details of a private codebase.
