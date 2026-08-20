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
5. `refine_scenario` evaluates retrieve-before guards and retrieve-after next.

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

## Plug-in surface (what an app provides)

- Quint sources plus a generate config (vocab, retrieve sets, source glob).
- `quint_ownership!` on each implementation primitive.
- A `PrimitiveDriver` that knows how to run those primitive ids.
- `NormalizedRuntimeEvidence` for domain snapshots.

Coverage policy (which scenarios are required, `coverage.toml`) stays in the
product. This crate does not know Arch Gateway.

## Generate

`harness/generate.mjs` runs `quint test --out-itf`, extracts runs, classifies
guards, and attaches per-action `next` from ITF deltas. The Quint app supplies
vocab and retrieve maps; the engine does not hard-code connector action names.

## Example

`examples/two_phase_commit/` is a tiny 2PC: Quint has `prepare`, `flushWal`,
`commitPrepared`; Rust `commit()` is one function that refines those three.

```
cargo test --test two_phase_commit
cargo run --example two_phase_commit
```
