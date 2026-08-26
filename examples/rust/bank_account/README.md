# Bank refinement tutorial project

This is the completed project from the [step-by-step tutorial](../../../docs/tutorial.md). It continues Quint's bank tutorial by generating the refinement boundary directly from `bank.qnt`, then checking that a Rust withdrawal follows the verified transition.

```console
# From the repository root:
npm ci
cd examples/rust/bank_account
node ../../../packages/compiler/cli.mjs compile bank.qnt
cargo run
cargo test
```

There is no app configuration or trace-generator JavaScript in this project. The compile command reuses Quint's AST and writes `quint-refinements.json` plus `src/generated_refinement.rs`.

The boundary is small and explicit:

```text
bank.qnt withdraw(4)
        -> quint-refinements.json
        -> generated ownership record "bank.withdraw"
        -> Bank::withdraw(4)
        -> Snapshot { balance: 6 }
        -> generated guard and next-state checks
```

`npm run check` fails when either generated artifact no longer matches `bank.qnt`.
