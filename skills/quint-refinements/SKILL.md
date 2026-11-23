---
name: quint-refinements
description: Use when validating real code against a Quint model with quint-refinements - writing or changing a .qnt model, adding @conformance scenarios, compiling the artifact and adapter, writing the Rust, Go, TypeScript or Elixir implementation of the generated interface, reading a divergence, or reviewing whether a model and its replay prove what they claim. Also use when asked to "model this in Quint", "prove the code matches the model", "add a refinement", or when a bug is an ordering, retry, crash or concurrency bug that unit tests keep missing.
---

# Validate code against a Quint model

`quint-refinements` compiles a Quint model into scenarios plus a typed adapter, then drives real code through each scenario and compares the code's state with the model's after every step. This skill is the working method around that tool: what to model, how to shape the model, how to connect it to code, and how to show the result is not a false pass.

"quint-refinements" means this repository (`ArchAstro/quint-refinements`). It is not `quint-connect` or any other Quint tool. If the user says "quint refinements", use this one.

## Read first

1. The reference for commands, conventions and error messages is the tool's own documentation at <https://archastro.github.io/quint-refinements/> (in the repository: `README.md`, `docs/how-it-works.md`, `docs/reference/model.md`, `docs/troubleshooting.md`). This skill does not repeat it.
2. Before designing anything in a codebase that already has models, find one (`git ls-files '*.qnt'`) and copy its layout, harness and adapter shape. Do not invent a second pattern.
3. Before using a compiler or runtime API, check that it exists at the version the project pins (`grep` the installed package). APIs have been renamed between commits, and a guessed name wastes a review cycle.
4. Some behavior described here is newer than release 0.2.0: checking an action against the state Quint reached when it uses an operator outside the runtime vocabulary (0.2.0 fails `compile` with `uses unsupported normalized operators`), comparing maps as reported, artifact schema version 3, and the Go, TypeScript and Elixir adapters. Check the project's pinned version and the changelog.

## When a model pays for itself

1. Use it for state that outlives one call and is changed by several actors: leases, claims, cursors, retries, crash recovery, lock ordering, cutovers, protocols over an unreliable network or store.
2. A good candidate has a history of fix commits for ordering or retry bugs, a decision function that is (or can be made) pure, and rules you can state in one sentence each.
3. Do not model arithmetic or single-call business rules. A model of those is a second copy of the code, and unit or property tests are cheaper.
4. A model checks the design. The refinement checks that the code follows the design on the scenarios you wrote. Neither covers code the model abstracts away; that code needs its own tests.

## The loop

Do these in order. Each step has a check that must pass before the next.

1. **Decide the boundary.** Name the production functions the model's actions will call, and the state the snapshot will read. If the logic is tangled into I/O, first extract a pure `apply(state, transition)` or `decide(...)` function that the existing code calls, with no behavior change and the existing tests still passing.
2. **Write the model.** One `var state` record that mirrors the stored fields. One action per production transition. See [references/modeling.md](references/modeling.md).
3. **Typecheck after every edit.** `quint typecheck model.qnt`. See [references/quint-gotchas.md](references/quint-gotchas.md) for the errors you will hit.
4. **Write scenarios.** One `/// @conformance` run per behavior you want pinned to the code, including one per past incident. Run names end in `Run`. Run them in Quint first: `quint test scenarios.qnt --main=scenarios --match='Run$' --max-samples=1`.
5. **Search the model.** `quint run` with a random `step` and your invariants, a fixed seed, and enough steps to reach the interesting states. Fix the model or the design until it holds.
6. **Show the model can fail.** Witnesses and broken variants, per [references/teeth.md](references/teeth.md). A model that cannot fail proves nothing.
7. **Compile.** `npx quint-refinements compile scenarios.qnt ...`. Commit the artifact and the generated adapter.
8. **Write the adapter.** Implement the generated interface by calling production code and reading real state. See [references/adapters.md](references/adapters.md).
9. **Run the replay**, then break production code by hand and confirm the replay names the scenario and field. Revert, and confirm the diff is clean.
10. **Get an independent review** of model fidelity from a reader who has the code and not your conclusions.
11. **Write down the limits**: what is simulated and not proved, what is faked, what is not modelled.

When behavior changes later, change the model first, then the code. A behavior change that does not touch the model means the model no longer describes the product.

## A minimal model

[example/lease.qnt](example/lease.qnt) and [example/scenarios.qnt](example/scenarios.qnt) show the shape in 60 lines: a state record, a design switch, a history flag with its invariant, a witness, a random `step`, one `@conformance` run and one `.fail()` test.

```console
quint typecheck example/lease.qnt
quint test example/scenarios.qnt --main=scenarios --match='(Run|Test)$' --max-samples=1
quint run example/lease.qnt --main=lease --invariant=neverTakesALiveLease --max-steps=20 --max-samples=5000 --seed=0x5eed
quint run example/lease.qnt --main=lease --invariant=neverClaimed --max-steps=20 --max-samples=5000 --seed=0x5eed
```

The third command must print `[ok]`. The fourth must print `[violation]`: `neverClaimed` is a witness, and its violation shows the random walk does claim leases. Set `CHECK_EXPIRY = false` and the third command must print `[violation]` too.

## Rules that prevent false passes

1. **The snapshot reads real state.** Build it from the database, the struct, the server's responses. A snapshot that echoes what the test just told the code to do passes on a false report.
2. **Report whole maps.** A map in the snapshot is compared as reported. Report every entry production holds, not only the ones a step touched.
3. **Compare exactly.** No rounding, truncating or `div` when mapping production values to model values. If a value does not map exactly, fail the snapshot.
4. **Call production code, not a copy.** If the adapter re-implements a rule in test code, the replay checks the copy. Where a fake is unavoidable, say so in the write-up.
5. **Call it a refinement only if every action is driven and the state is compared after each one.** Comparing a few hand-picked states is checkpoint comparison. Say which one you built.
6. **A field no obligation reads is not compared after an action.** The runtime checks the snapshot fields that some guard, assignment or assertion names; a field nothing reads keeps the model's value. Make sure every field of `state` is read by an action or assertion in some scenario, and prove it by blanking that field in the snapshot after an action.
7. **A quint exit code of 0 is not a verdict.** Require `[ok]`, `N passing` or the model checker's state count in the output, and treat any other `error:` line as failure. A run that is meant to fail must print `[violation]`; its `error: Invariant violated` line and exit code 1 are expected.
8. **Random simulation is evidence, not proof.** Say "simulated N traces of M steps, seed S". Say "proved" only for an exhaustive check, and name its bounds.
9. **Each invariant has a variant that breaks it**, checked against that invariant alone. An unrelated violation must not count.
10. **Each claim in the write-up has a named check that fails without it.**
11. **Fix the tool, not the model, when the tool is wrong.** If the compiler or a runtime mishandles valid Quint, report or fix it upstream. Do not encode `-1` as `99`.

## Which way to fix a disagreement

1. The replay diverges and production's behavior is intended: fix the model. Add a variant so the old model behavior must fail.
2. The replay diverges and production is wrong: write the failing scenario first, then fix production. Keep the scenario.
3. Check the adapter before either. Most first-run divergences are glue: a fixture row missing a column, a counter not reset, a name mapped wrong.
4. Never delete an assertion to make a run pass. Replace it with the precise statement that is true.
5. A hypothesis about the system that turns out false is a finding. Report it, and pin it with a scenario.

## What to hand back

1. A table of model action to production function.
2. The invariants, in one sentence each.
3. The broken variants and production mutations, each with the scenario and field that caught it.
4. Scenario count and obligation count from the replay.
5. Three lists: what is simulated and not proved, what is faked, what is not modelled.

## References

| File | Read it when |
|---|---|
| [references/modeling.md](references/modeling.md) | Shaping state, actions, time, crashes, networks, databases, concurrency |
| [references/quint-gotchas.md](references/quint-gotchas.md) | Quint rejected something, or a command behaved oddly |
| [references/adapters.md](references/adapters.md) | Writing the implementation side, or reading a divergence |
| [references/teeth.md](references/teeth.md) | Showing the model and the replay can fail; reviewing a model |
| [references/operations.md](references/operations.md) | Harness scripts, CI, version pins, artifact size, machine load |
