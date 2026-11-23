# Modeling

How to shape a Quint model so it finds bugs and can be replayed against code.

## 1. Files

Split by job. `scenarios.qnt` and `properties.qnt` import `model.qnt`, which imports `policy.qnt` if there is one. The example in this skill keeps the step, switch and witness in one file because it is small.

| File | Holds |
|---|---|
| `model.qnt` | Types, the `state` record, one action per production transition, pure decision functions, constants |
| `scenarios.qnt` | `/// @conformance` runs. This is the file you compile |
| `properties.qnt` | The random `step`, invariants, witnesses, history variables that only properties need |
| `policy.qnt` (optional) | Design switches, one `pure val` per decision |

1. Keep an infrastructure model (a store, a database, a network) in its own module with no `var`, so other models can import it.
2. Write a feature as a pair of pure functions over the state, `xCan(s, ...)` (is it allowed) and `xNext(s, ...)` (the next state), and wire them into actions in one top module. A new protocol is a new file of pure steps plus its actions.
3. Names must be unique across every imported module. The compiler flattens qualified imports.
4. A model for code that does not exist yet needs only `quint test` and `quint run`. Add the artifact and adapter when there is code to drive.

## 2. State

1. One `var state` record. The compiler requires it. Mirror the stored fields one for one, and comment each field with the column or struct field it stands for.
2. Represent "none" with a sentinel (`""`, `0`) and map it in the adapter. Records map more cleanly than tuples.
3. Every field is copied into every state of every scenario in the artifact. Before adding a field, ask whether a property needs it or the code holds it. See [operations.md](operations.md#4-artifact-size).
4. History that only properties read ("was this ever true") goes in extra variables in `properties.qnt` or a side module, not in `state`. Quint's `then` needs both sides to assign the same variables, so wrap base actions:

   ```quint
   action keep(a: bool): bool = all { a, seen' = seen }
   ```

5. A derived field the code also stores (a flag computed from other fields) is recomputed in one pure helper that every write goes through. Do not set it by hand in each action.

## 3. Actions

1. One action per production transition. Each action changes state in one `state' = ...` assignment, so the compiler can turn it into a guard list and a next-state obligation.
2. A pure decision function becomes an action that writes its result into state. The replay then compares the decision after every step:

   ```quint
   action poll(input: Input): bool =
     state' = { ...state, decision: decide(state, input) }
   ```

3. Shared helpers are `pure def` (or `def` if they read `state`). Every top-level action a scenario calls becomes a method the implementation must provide, so a helper written as an action adds a method nobody wanted.
4. Give a protocol explicit phases, one action per phase (`start`, `claim`, `apply`, `complete`). A crash scenario is then a run that stops between two of them.
5. Use `@primitive` only when one production command performs several actions and cannot be interrupted between them. If a crash between two actions matters, leave them as separate actions.
6. A step that is two requests in production is two actions in the model. A model that checks and writes in one atomic step hides the race between them.
7. Keep guards and assignments inside the runtime vocabulary where you can ([`expression_vocabulary.json`](https://github.com/ArchAstro/quint-refinements/blob/main/packages/compiler/expression_vocabulary.json)). An action that uses an operator outside it (`foldl`, `intersect`, `head`, `slice`, `to`, `subseteq`, integer multiplication) is checked only against the state Quint reached, and its guards are not checked one by one. Release 0.2.0 rejects such an action at `compile` with `uses unsupported normalized operators`. Common rewrites:

   | Outside the vocabulary | Inside it |
   |---|---|
   | `a.intersect(b)` | `a.filter(x => b.contains(x))` |
   | `a.subseteq(b)` | `a.forall(x => b.contains(x))` |
   | `xs.foldl(...)` counting | `xs.indices().filter(i => ...).size()` |
   | An ordered list you fold over | A map from key to position |

8. Helpers are inlined into each obligation. A value used twice is expanded twice. Bind it once: `Set(v).exists(x => ...)` or `Set(v).fold(init, (_, x) => ...)`.
9. Assertions in observation blocks are always evaluated by the runtime, so they must stay inside the vocabulary.

## 4. The environment

The random `step` decides which histories the search sees.

1. **Small domains.** Two or three ids, so collisions happen: `pure val jobs = Set("j1", "j2")`. Abstract a cap of 32 to a cap of 2.
2. **Constrain `step` to what the real caller does.** If the walk can take a transition the code never takes, invariants fail on impossible histories. Track what was decided in a history variable and let the walk take only the transition that follows from it.
3. **Malformed inputs too.** If `step` only generates well-formed requests, the guards that reject bad ones are never exercised. Check by removing a guard: if the search stays green, the search does not test it.
4. **Every new event dilutes the walk.** After adding an action to `step`, re-run the witnesses. A sudden speed-up after adding environment actions usually means runs stopped reaching the interesting states.
5. **Gate noisy events.** Let time or fault actions fire on a random draw (one run in three) so most runs still make progress.
6. **Scripted starts for deep bugs.** When a counterexample needs a long prefix the walk rarely strings together, write an action that performs the prefix and pass it as `--init`:

   ```quint
   action nearlyDone = init.then(start(1)).then(claim(1)).then(apply(1))
   ```

   Invariants are not checked on the states inside the scripted prefix, only from its last state on.

7. **Restricted steps for rare counterexamples.** A step with one machine and no lease moves can find in milliseconds what the full step misses in 500,000 samples. Run safety over both.

## 5. Time

1. Abstract time to the facts the decision reads: `delayPassed: bool`, `attempts: int`. The adapter turns them into real timestamps.
2. If durations interact, use a discrete `now` and a `tick` action with small constants (a TTL of 6, a refresh every 2).
3. State timing assumptions as named constants (`LATENCY`, `SKEW`) and search a grid of them. The result is a rule such as "safe when latency plus skew is at most half the TTL", which is more useful than one passing configuration.
4. Quint integers are unbounded. If production uses 64-bit integers, bound the model explicitly or it cannot show an overflow.

## 6. Crashes, lost replies and networks

1. **Crash.** An actor stops at any phase. Its lease must age out, not vanish, or the model hides the window where a dead holder still blocks others.
2. **Lost reply.** Model each request to a store as its own action with three outcomes: answered, performed but the reply lost, never arrived. Most real bugs in store-backed protocols are the second one: the caller retries a write that already landed.
3. **Network.** Keep every sent message in a set forever. One `deliver(i)` action that can deliver any message at any time, any number of times, gives loss, delay, reordering, duplication and partitions from a single rule. The [Raft network guide](https://github.com/ArchAstro/quint-refinements/blob/main/docs/guides/raft-network.md) builds one.
4. **Faults as typed actions**, each with its own invariant: a transient fault never causes a rollback; a permanent fault ends at "needs an operator".
5. **Outside systems are writers, not mechanisms.** Model another system (an autoscaler, an operator, an older controller) as an action that ignores your locks and can write any value to the fields it owns. Do not model how it works inside. A model with only your own well-behaved actors cannot express the outage where something else wrote over you.
6. **Stuttering.** A model checker reports a deadlock on a terminal state. Add an `idle` action that leaves the state unchanged to `step`.

## 7. Databases and concurrency

When the bug class is lock ordering or isolation, model the database.

1. Tables are types. Each constraint and trigger is a predicate.
2. One production call is a plan: a list of SQL statements. A `step(caller)` action advances one caller by one statement, so the search interleaves callers per statement.
3. Model what the isolation level really does: which rows a statement sees, which locks it takes and in what order, when a unique index makes it wait, what a savepoint undoes.
4. Record each statement's answer in the caller's log (`Done`, `Found`, `Missing`, `UniqueViolation`, `Waiting(holders)`), and assert on the log in scenarios.
5. Let the real database correct the model. A replay against a real database will show where the model's semantics are wrong (for example, a failed statement releases its locks at once, not at `ROLLBACK`).

For several machines, hold `machines: str -> Machine` plus one record for the shared service, and make the service's compare-and-set the only way ownership changes. Model the value the code actually stamps on a write (the lease it read under), not the one you assume.

## 8. Properties

1. **Invariants** are pure predicates over the state. Export each one alone and also a conjunction `safety`.
2. **"Never did X"** is a history flag set by the deciding action plus an invariant that the flag is false. This turns a temporal property into a state invariant every backend can check:

   ```quint
   tookLiveLease: state.tookLiveLease or (live(state) and state.lease.holder != m)
   ```

3. **An invariant must not reuse the transition function it checks.** Restating the model's own guard is a tautology. Write the property independently.
4. **Liveness** is cheapest as a bounded safety property: "a machine with work holds the lease within 5 answered passes". State the assumption the bound depends on. Use `temporal` with weak fairness and an exhaustive checker only on a small model.
5. **Every guard that blocks something needs a progress scenario and a bound scenario**: the blocked thing still happens once the condition clears, and it still happens if the condition never clears.
6. **To compare two predicates**, check the temporary invariant `not(p) or q` and then the reverse. A counterexample shows exactly where they differ.
7. **For an exhaustive check, write a reduced module**: its own initializer choosing from a handful of hand-built mid-protocol states, a depth bound and a fault budget as constants, and a one-step history variable where a property needs "what just happened". Random runs and exhaustive runs find different bugs; a rule missing from a model can survive every random run and fall to the first exhaustive one.
8. **Start from hypotheses and check them against the code.** Keep the true ones. A false one is a finding, not something to weaken quietly. If the fix is not yours to make, pin the strict invariant as "must keep failing" so the fix is noticed when it lands.

## 9. Design switches

Write each design decision as a constant that is `true` in production:

```quint
pure val CHECK_EXPIRY = true
```

1. The action reads the switch. Flipping it reproduces the bug the decision prevents.
2. A fixed bug stays reproducible forever as a switch, with no second copy of the model.
3. The harness flips each switch and requires a counterexample. See [teeth.md](teeth.md).
4. Prefer a text replace of one switch in a scratch copy over whole-file mutant copies. With whole-file copies, every new switch must be added to every copy, and a forgotten one shows up as a parse error that reads like a missed violation.

## 10. Scenarios

1. One run per behavior, named for the behavior, ending in `Run`. The compiler finds scenarios with `--match=Run$`, and a run with another name gives `missing ITF trace`.
2. Give each run a doc comment that tells the story, and comment each step. An incident becomes a named run with the date in its comment.
3. A mid-run check is its own step: `.then(all { assert(...), state' = state })`.
4. Very long `.then` chains overflow the Rust evaluator (`recursion limit exceeded`). The limit depends on state size: around a hundred steps on a tiny model, far fewer on a large one. Split long runs.
5. Scenarios take only steps the model allows. To check that the model refuses a step, write an ordinary test ending in `.fail()`; it is not replayed. Refusal paths in the code need unit tests.
6. **A refused step is invisible to the replay.** The replay drives only enabled actions, and there is no "this action must be disabled" step. If the property is "a fenced-off stale writer changes nothing", model the attempt as an enabled action whose next state equals the current state (`staleApply`), and call it in a scenario. Code that lets the stale write through then diverges.
7. **Make each guard the only thing that rejects a step.** If two guards both refuse the scenario's bad step, removing either one in the code goes unnoticed. Write one scenario per guard in which only that guard stands in the way.
8. Scenarios can be generated inside Quint from a list of seeds or cases when there are dozens of similar ones. Keep the hand-written, named ones for incidents.
9. Do not name anything else `...Run`. A helper with that suffix is executed as a scenario.
10. When a change adds behavior, add the bundle: the switch, the history flag and its invariant, a scripted start if the walk cannot reach it, the scenario that replays it, a progress and a bound scenario, and a line in the README's list of decisions.
