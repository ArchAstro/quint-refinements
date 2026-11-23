# Quint: commands and gotchas

Errors and surprises met while writing real models, each with the fix. Quint's own documentation is at <https://quint.sh/>.

## 1. Commands

Quint ships inside the `quint-refinements` npm package. For direct use, pin `@informalsystems/quint` in the project and call it through the package manager.

| Goal | Command |
|---|---|
| Typecheck (after every edit) | `quint typecheck model.qnt` |
| Run scenarios | `quint test scenarios.qnt --main=scenarios --match='Run$' --max-samples=1` |
| Run one scenario with its trace | `quint test scenarios.qnt --match='^nameRun$' --verbosity=3` |
| Random search | `quint run properties.qnt --main=properties --init=init --step=step --invariant=safety --max-steps=20 --max-samples=50000 --seed=0x5eed` |
| Reproduce a counterexample | Re-run with the `--seed=0x...` Quint printed, and `--verbosity=3` |
| Bounded symbolic check | `quint verify model.qnt --invariant=safety --max-steps=14` |
| Exhaustive check | `quint verify model.qnt --backend=tlc --invariant=safety` |

1. `quint test` with no `--match` runs only definitions whose names end in `Test`. Scenarios named `...Run` need `--match='Run$'`.
2. A scenario has no nondeterminism, so `--max-samples=1` runs it once. Without a seed, the default repeats it many times.
3. Pass `--seed` and `--max-samples` together. A fixed seed makes a failure reproducible. With `--seed` and no `--max-samples`, Quint runs one sample, so a search prints `[ok]` after a single trace.
4. `--init` and `--step` choose a scripted start or a restricted step relation.
5. Use several seeds for safety runs and witnesses. One fixed seed has missed a real race that the next seed found, and a witness tied to one seed breaks when the model changes.
6. Scenarios can run on `--backend=typescript` when the Rust evaluator fails on them (`recursion limit exceeded`); the compiler runs them that way itself. Random search wants the Rust backend for speed.
7. `quint run --mbt --out-itf=trace.itf.json` writes traces with the action taken at each step, for tools that replay random traces.
8. Very large output at high verbosity can crash Node. Lower `--verbosity` or the sample count when printing traces.
9. Cost is in the steps, not the invariants. Throughput falls with state size: from tens of thousands of traces a second on a small model to under 20 on a large one. Raise `--max-steps` until witnesses are found reliably, then size `--max-samples` to the time you have.

## 2. Verdicts

1. Do not trust the exit code alone. Require a positive marker in the output: `[ok]`, `[violation]`, `N passing`, or for TLC `N distinct states found, 0 states left on queue`.
2. For a run that should pass, treat a line starting with `error:` as failure even when the exit code is 0. For a run that should fail (a witness or a broken variant), require `[violation]`; its `error: Invariant violated` line and exit code 1 are expected. Any other error, such as a parse error, means the check did not run.
3. `quint verify` can exit 0 with no verdict when its model-checker server throws: once Quint has started the server, its own handler for uncaught exceptions swallows the error. A harness can preload a small Node script that prints the exception and sets a distinct exit code. A harness should treat "exit 0 and no marker" as no verdict, not as a pass.
4. A process killed by a signal leaves no verdict either. Record the exit status and signal next to the output.

## 3. Backends

1. `quint run` uses a Rust evaluator that Quint downloads on first use into `~/.quint`. The download goes through GitHub's unauthenticated API and fails with `rate limit exceeded` on shared runners. Cache `~/.quint` in CI, or install the evaluator ahead of time.
2. Two Quint processes installing into `~/.quint` at once can corrupt the install. Install once before starting parallel checks.
3. `quint verify` starts an Apalache server on a fixed port. Run `verify` calls one at a time, or give each its own `--server-endpoint=localhost:<port>`.
4. Apalache needs Java, and newer Quint releases need a newer Java. Check the pair before pinning. Set `JAVA_HOME`.
5. The symbolic backend gives up on nonlinear integer arithmetic (`z3 reports UNKNOWN`). For a model that multiplies or uses powers, use `quint run` and report it as simulation.
6. TLC through `--backend=tlc` explores exhaustively, and on a finite control model it goes much deeper than the symbolic backend in the same time (millions of states in minutes, against a few steps). Give it a reduced module: one tier, a handful of start states, a depth bound and a fault budget as constants.

## 4. Names

1. `QNT101 Built-in name 'X' is redefined`. A parameter, lambda argument, `val` or `def` cannot reuse a built-in name. Ones that come up: `next`, `keys`, `item`, `set`, `put`, `filter`, `to`, `head`, `exists`, `append`, `field`, `flatten`. Rename it.
2. `QNT101 Conflicting definitions found for name 'X'`. A local definition clashes with an imported one, or a variant shares its type's name. Rename the local one.
3. Variant names are global. Prefix them (`WSave`, `WLoad`) when two sum types would share one.
4. `run`, `any`, `all` and `match` are keywords. Using one as a name gives a parse error (`QNT000`, or `QNT008` for `match`), not `QNT101`.
5. A module that imports the model with `import model.*` cannot define its own `init`. Name it `simInit` and pass `--init=simInit`.
6. `QNT404 Name 'X' not found` in a file you did not edit usually means a stale copy of an imported module (a mutant copy that lacks a new constant).
7. `QNT099 Found cyclic declarations` is often a name collision, not recursion. Rename or inline.

## 5. Definitions

1. `QNT200 pure def operators may not interact with state variables`. A helper that reads `state` is a `def`. A helper that does not is a `pure def`. Something that assigns `state'` is an `action`.
2. If a `val` inside a lambda body or a nested definition gives a name-resolution error you cannot explain, move the work into a top-level `pure def` and pass what it needs.
3. If one user-defined higher-order operator called inside another gives an impossible result (an evaluator panic, or `missing record field`), write the inner one inline with `fold`. This was seen on Quint 0.32.
4. Lambdas are not values you can store, and lambda parameters cannot carry type annotations.
5. Every branch of an `any`, and both sides of a `then`, must assign the same variables.
6. `chooseSome` typechecks but fails in the simulator (`QNT501`). Pick with `nondet x = s.oneOf()` in an action instead.

## 6. Syntax

1. A list literal directly after a parenthesised expression can be read as indexing into it. If `[a, b]` produces a strange parse or type error, write `List(a, b)`.
2. Nested patterns in `match` (`| Wait(Save(x)) =>`) fail to parse, with a misleading `Reserved keyword 'match'` error. Match the outer variant, then call a helper that matches the inner one.
3. A boolean expression on the right of `x' =` needs parentheses.
4. Strings have no escapes and cannot be sliced. Model text as `List[str]`.
5. `range(i, j)` returns a list. `i.to(j)` returns a set.
6. There is no built-in `Option`, no `getOrElse` on maps and no `forall` on lists. Define the sum type, test `keys().contains(k)` first, and use `indices().forall(...)`.
7. Quint has no negative literal: `-1` is the negation operator applied to `1`. This is fine in models; it matters only to tools that read the syntax tree.
8. After any scripted edit of a `.qnt` file, typecheck at once. Prefer exact string replacement that asserts the old text was present. Regex edits have turned `Set(` into something else without an error, and BSD `sed` ignores `\b`, so a rename can silently do nothing.

## 7. Runs

1. `then` requires both sides to assign the same variables. With extra variables in a side module, wrap each base action so it also assigns them.
2. `QNT508 Assertion failed` in a scenario means the scenario's expectation or the model is wrong. Read the trace with `--verbosity=3` before changing either.
3. `QNT516 Rust evaluator exited ... recursion limit exceeded` means a `.then` chain is too long for the state it carries. Split the run, or run scenarios with `--backend=typescript`.
4. `QNT516 ... Expected boolean` usually means a definition that is not a scenario was executed as one, because its name ends in `Run`.
5. `.expect(...)` endings work in plain tests, but the compiler does not accept them in `@conformance` runs. End with `all { assert(...), state' = state }`.
