# Examples

Run these in order:

1. Follow [`../docs/tutorial.md`](../docs/tutorial.md), then run:
   `cargo run --manifest-path examples/rust/bank_account/Cargo.toml`
   - Builds a complete standalone bank project: a Quint model, the generated adapter, and a real Rust command.
   Then the guide projects, each built step by step in [`../docs`](../docs/README.md):
   - `cargo run --manifest-path examples/rust/shop_orders/Cargo.toml`: named constants, an `if`/`else` action, a model in two files.
   - `cargo run --manifest-path examples/rust/transaction_commit/Cargo.toml`: one `commit()` owning three actions, and a constant bound to a Rust value.
   - `cargo run --manifest-path examples/rust/raft/Cargo.toml`: Raft leader election, replication and commit on three nodes, using only the standard library.
   - `cargo run --manifest-path examples/rust/raft_network/Cargo.toml`: the same Raft over a network that loses, delays, reorders and duplicates messages.
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

## Go

The same models, implemented in Go against the Go runtime. Each is its own module and resolves the runtime to this checkout:

1. `cd examples/go/bank_account && go run .`: the tutorial's bank. `go test` also runs a deliberately wrong bank and checks the divergence message.
2. `cd examples/go/raft && go run .`: the Raft cluster, standard library only. Its per-scenario obligation counts equal the Rust example's.
3. `cd examples/go/raft_network && go run .`: Raft over a lossy network.
4. `cd bindings/go && go test ./examples/... ./corpus/...`: one `Commit` method owning three actions, with a Go enum bound as a model fixture, and the shared corpus.

## TypeScript

The same models, implemented in TypeScript against the runtime in `bindings/typescript`. Run `npm ci && npm run build:runtime` once at the repository root: the examples import `quint-refinements/runtime`, which resolves to that build. Node 22.18 or newer runs the `.ts` files directly.

1. `node examples/typescript/bank_account/main.ts`: the tutorial's bank. `node --test examples/typescript/bank_account/bank.test.ts` also runs deliberately wrong banks and checks the divergence messages, and an implementation whose methods return promises.
2. `node examples/typescript/two_phase_commit/main.ts`: one `commit()` owning three actions, with a status universe bound to a production value, run through the async runner.
3. `node examples/typescript/raft/main.ts`: the Raft cluster, standard library only. Its per-scenario obligation counts equal the Rust example's.
4. `node --test bindings/typescript/corpus/corpus.test.ts`: the shared conformance corpus.

