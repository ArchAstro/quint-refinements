# quint-refinements

Framework for running a Quint model as a refinement of a real implementation.

## Why this crate exists

Arch Gateway conformance grew a JSON artifact, ownership records, and
`evaluate_every_action_step`, then still *drove* scenarios with handwritten
scripts. One Rust command (`invoke`) implements three Quint actions
(`submitInvocation`, `selectForAttempt`, `enqueueSelectedDelivery`). The
scripts invented the middle snapshots (copy Hello, `with_selection`, map
action names to `last_*` tags). Green tests did not prove the impl took those
three spec steps.

The cheat is easy when evaluation is generic but **execution is a per-scenario
story**. This crate makes execution generic too.

## The only legal loop

1. Generate JSON from a Quint app (`harness/`).
2. Rust primitives declare ownership (`quint_ownership!`).
3. `schedule_primitive_runs` maps JSON actions onto primitive runs.
4. `PrimitiveDriver::run_primitive` runs **one** impl command and returns
   **exactly** `owned_actions.len()` snapshots, in that order.
5. Rust structs own Quint fixture names (`FixtureTable` / `QuintFixture`).
6. `refine_scenario` evaluates **every** retrieve-before guard and retrieve-after
   next conjunct. Fixture names resolve from the table; `state` resolves from
   the snapshot. Nothing is skipped.

1-to-N is declared, not inferred:

```rust
quint_ownership! {
    pub const ENQUEUE = {
        primitive: "gateway.delivery.enqueue",
        refines: ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"],
        observations: [/* retrieve-able after the command */],
    };
}
```

`refines` is the ordered spec tape of **one** impl command. The driver returns
that many snapshots. JSON must present the sequence intact. `aliases` are extra
JSON names for a 1-step refine only (`openConnection` / `openConnectionForRuntimeOwner`).
A flat `actions` list still means independent 1-step names (coverage ownership
of several commands), not a sequence.

## Fixtures

Quint `pure val` names (`Idle`, `attemptA`) and universe sets
(`statuses.contains(...)`) are not model-only skips. They are Rust values
that must match the JSON artifact:

```rust
impl QuintFixture for Status { /* artifact_json + runtime_value */ }

let fixtures = FixtureTable::new("two_phase_commit")
    .insert("Idle", &Status::Idle)
    .insert_set("statuses", &[Status::Idle, Status::Open, /* ... */]);
fixtures.validate(&artifact)?;
```

- **Fixture names** — production (or example) structs. Validate fails if a JSON
  name has no owner or if the JSON shape drifted from the struct.
- **Live `state.*`** — retrieve-before / retrieve-after snapshots.
- **Observe `*Inv` theorems** — still Quint-only; those are not action guards.

`evaluate_every_action_step` still skips `scope: model` for unmigrated
gateway runners. `refine_scenario` / `evaluate_refined_tape` do not.
`assign` is a boolean (`x' = e`): RHS in the current snapshot, LHS in
the next, including when it is nested under `match` / `if`.

## Plug-in surface (what an app provides)

- Quint sources plus a generate config (vocab, retrieve sets, source glob).
- `quint_ownership!` on each implementation primitive.
- A `FixtureTable` of real structs for every Quint name the JSON uses.
- A `PrimitiveDriver` that knows how to run those primitive ids.
- `NormalizedRuntimeEvidence` for domain snapshots (`state` only).

Coverage policy (which scenarios are required, `coverage.toml`) stays in the
product. This crate does not know Arch Gateway.

## Generate

`harness/generate.mjs` runs `quint test --out-itf`, extracts runs, encodes
**every** `all { }` conjunct: unprimed predicates as before-guards, `x' = e`
as after (`assign`). Unknown AST kinds fail closed. Observe keeps the closed
adapter vocabulary. ITF last_* deltas are extra runtime next, not a substitute
for the Quint assignment.

An app selects skip-nothing runs by stable module and run id:

```js
generateConformanceTraces({
  root,
  specDir,
  fullyRefinedRuns: new Set(["two_phase_commit.commitRun"]),
})
```

Selected runs recursively inline Quint definitions and lets. Unselected runs
keep the smaller compatibility artifact while their runtime adapters migrate.
Runtime maps retain structural keys, sets retain structural members, and
assignment compares the complete normalized before/after state exactly. Each
selected run also carries its generated ITF initial state, so adapters start
from every model field and overlay concrete observations instead of building a
sparse test twin. `expression_vocabulary.json` is the shared generator/Rust
operator contract; selecting a run with an unsupported operator fails during
generation.

## Example

`examples/two_phase_commit/` is a tiny 2PC: Quint has `prepare`, `flushWal`,
`commitPrepared`; Rust `commit()` is one function that refines those three.

```
cargo test --test two_phase_commit
cargo run --example two_phase_commit
```
