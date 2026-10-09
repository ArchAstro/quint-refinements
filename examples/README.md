# Examples

Run these in order:

1. Follow [`../docs/tutorial.md`](../docs/tutorial.md), then run:
   `cargo run --manifest-path examples/rust/bank_account/Cargo.toml`
   - Builds a complete standalone bank project: a Quint model, the generated adapter, and a real Rust command.
2. `cargo run --manifest-path bindings/rust/Cargo.toml --example ownership_records`
   - Declares one-step ownership, aliases, and an ordered 1-to-N sequence.
3. `cargo run --manifest-path bindings/rust/Cargo.toml --example fixture_ownership`
   - Binds generated Quint names to Rust values and validates drift.
4. `cargo run --manifest-path bindings/rust/Cargo.toml --example structural_values`
   - Preserves records, structural map keys, sets, tuples, and variants from Quint ITF.
5. `cargo run --manifest-path bindings/rust/Cargo.toml --example failure_modes`
   - Shows partial action sequences and short evidence tapes failing closed.
6. `cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit`
   - Generates one `commit()` hook for three Quint actions from a `@primitive` line, and binds a Rust enum as a model fixture.
7. `cargo run --manifest-path bindings/rust/Cargo.toml --example two_phase_commit_async`
   - Runs the same generated adapter through the async driver.

Use the bank project as the template for normal integrations and the two-phase commit directory when one production command owns several ordered Quint actions. Examples 2 to 5 use the runtime API directly, without the compiler.
