# Showing the model and the replay can fail

A green run means something only if a wrong model or wrong code would have turned it red. This page lists the checks that establish that, and how to review someone else's model.

## 1. Four checks, all required

| Check | Shows | How |
|---|---|---|
| Witnesses | The search reaches the interesting states | An invariant that must be violated |
| Broken model variants | Each invariant can fail | Flip a design switch; require a counterexample |
| Production mutations | The replay can fail | Break the code by hand; require a named divergence |
| Harness mutations | The comparison can fail | Blank a snapshot field; require a failure |

## 2. Witnesses

A witness is the negation of a state you expect to reach, written as an invariant:

```quint
// Witness: must be violated, or the walk never claims anything.
val neverClaimed = state.lease.holder == ""
```

1. Write one per interesting outcome: a rollback happens, both versions serve at once, garbage collection deletes something, a retry is refused.
2. The harness requires `[violation]` for each. Accept the first of a few fixed seeds that reaches it.
3. Re-run witnesses after any change to `step`. New events dilute the walk.
4. If a witness is found once in 100,000 runs, raise `--max-steps` or add a scripted start. A search that reaches the state that rarely is not testing it.
5. Safety invariants alone pass for a model whose actions do nothing. Witnesses and scenarios are what show the actions have effects.

## 3. Broken model variants

1. Every invariant has at least one variant that should break it, usually a design switch set to `false`.
2. The harness copies the model to a scratch directory, applies one exact text replacement, and runs the search.
3. **The replacement must apply.** If the text to replace is not found, fail the harness. Otherwise variants rot silently.
4. **The variant is checked against its own invariant, alone** (`--invariant=<that one>`). When variants are checked against the combined `safety`, an unrelated violation stands in and the intended one is never tested.
5. Give variants more samples than the safety run (ten times is typical).
6. If the walk cannot reach the counterexample, the variant must instead fail a named scenario. Record which.
7. Tell a parse or typecheck error apart from "no violation found". A variant that does not compile has not been caught.
8. A variant nothing catches is a finding: either the invariant is weak, the search cannot reach the state, or the model has a real gap.
9. For a fixed bug, the negative case also holds for progress: with the fix switched off, the stuck state must stay stuck.

Report results as a table: variant, expected invariant or scenario, result.

## 4. Production mutations

After the replay passes, break production code and watch it fail.

1. Make three to five single-line breakages per model: remove a check, swap an order, change a constant, skip a write.
2. Each must fail the replay at a named scenario and field. Record the change and the message in the README.
3. Keep a backup, restore it, and confirm `git diff` shows only your intended changes. Never stage files while a mutation is applied.
4. To show a regression test fails without its fix, write the old file content over the new (`git show HEAD~1:path > path`), run, and restore. Do not stash or switch branches.
5. A mutation that survives means one of:
   - a missing scenario: add it;
   - a model step that is atomic where the code is not: split it;
   - a snapshot that does not read the field: fix the snapshot;
   - a runtime bug: report it;
   - an equivalent mutation: explain why.

   Expect survivors on the first pass over a new model, and work through each one.
6. Flipping a switch in the model tests the model. Only mutations of the implementation test the replay. Do both; they are not substitutes.
7. Scripted mutants keyed to generated names or line numbers break when the code changes, and a pattern can still match but break a different function. Re-check what each one edits after a refactor.

## 5. Harness mutations

1. In the adapter's snapshot, replace one observed field with an empty map or a default value in snapshots taken after an action. The replay must fail. Do this for every field: one that can be blanked unnoticed is read by no obligation, so the code can change it freely.
2. Keep one deliberately wrong implementation in the test suite and assert its exact divergence message.
3. If the model checks run through a script, give the script a canary: a deliberately false invariant and a missing module, both of which must be reported as failures.

## 6. Simulation and proof

1. Random search finds shallow bugs fast and deep ones rarely. In one protocol with seven rules removed one at a time, simulation found two and hand-written scenarios found all seven.
2. Run the simulator before trusting a new model; scenarios follow only the paths you thought of.
3. Write down the histories you know matter as scenarios; simulation will not find them for you.
4. Use more than one layer, because each misses what another finds: an exhaustive check on a reduced module, random search over several seeds, scenarios, mutation of the implementation, and for a replacement system a period running in shadow beside the old one. None of them covers the I/O adapters the model abstracts away; test those directly.
5. "Impossible to break" cannot be shown. Say what was checked and to what bound.
6. An exhaustive check is a proof only within its bounds: the depth, the number of actors, the fault budget. State them.
7. In the write-up, use "simulated" and "proved" precisely. A reviewer will check.

## 7. Independent review

After each slice, have a reviewer who did not write the model read it against the code. Give them the code and the model, not your summary. Ask them to judge from the code, not from the README.

Questions for the reviewer:

1. Where does the model misrepresent the code? Is there a route, statement or transition the code has and the model lacks?
2. Does `step` let the histories that matter happen? Is any action enabled so rarely that it never fires?
3. Is any invariant true by construction, or a restatement of a guard?
4. Does each broken variant violate the invariant written for it?
5. For each field the snapshot reports: is it read from the system, or derived from the test's own bookkeeping?
6. Is anything in the adapter a copy of production logic?
7. Can a guard block progress forever? Is it bounded?
8. Does every claim in the README have a check that fails without it? Is "proved" used for a simulation?
9. Does the test assert less than it claims?

Reviews of this kind have found: a missing route that let forged data be served, tautological invariants, invariants that reused the transition they checked, constants the harness never flipped, a comparison that truncated and so accepted a range of wrong values, leaked connections, and README claims with no check behind them.

Two reviewers with different methods find different things: one checks the model against the specification or paper with the simulator, the other mutates the code.

## 8. Before you call it done

1. Scenarios pass in Quint and in the replay, with the scenario list pinned.
2. `safety` holds under random search with a fixed seed; the numbers are written down.
3. Every witness is violated.
4. Every variant is caught by its own invariant or a named scenario.
5. Production mutations are recorded with the divergence each produced.
6. `compile --check` reports the generated files current, after formatting.
7. The README lists what is simulated, what is faked and what is not modelled, with a table that marks each production behavior as modelled, modelled but not exercised by any scenario, or not modelled.
