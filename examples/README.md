# Examples

Run these in order:

1. Follow [`../docs/tutorial.md`](../docs/tutorial.md), then run:
   `cargo run --manifest-path examples/bank_account/Cargo.toml`
   - Builds a complete standalone bank project from a Quint model, generated trace, ownership record, real Rust command, and snapshot evaluator.
2. `cargo run --example ownership_records`
   - Declares one-step ownership, aliases, and an ordered 1-to-N sequence.
3. `cargo run --example fixture_ownership`
   - Binds generated Quint names to Rust values and validates drift.
4. `cargo run --example structural_values`
   - Preserves records, structural map keys, sets, tuples, and variants from Quint ITF.
5. `cargo run --example failure_modes`
   - Shows partial action sequences and short evidence tapes failing closed.
6. `cargo run --example two_phase_commit`
   - Runs the full path from a checked-in Quint model and generated trace to a real synchronous Rust adapter.
7. `cargo run --example two_phase_commit_async`
   - Runs the same generated scenario through the async adapter contract.

The two-phase commit directory is the template for a consuming project. Copy its shape, then replace the model, app configuration, ownership records, fixtures, and driver with your domain.
