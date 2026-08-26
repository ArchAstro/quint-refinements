# Bank refinement tutorial project

This is the completed project from the [step-by-step tutorial](../../docs/tutorial.md). It continues Quint's bank tutorial by checking that a Rust withdrawal follows the verified Quint transition.

```console
npm install
npm run generate
cargo run
cargo test
```

The boundary is small and explicit:

```text
bank.qnt withdraw(4)
        -> traces.json
        -> ownership record "bank.withdraw"
        -> Bank::withdraw(4)
        -> Snapshot { balance: 6 }
        -> generated guard and next-state checks
```

`npm run check` fails when `traces.json` no longer matches `bank.qnt`.
