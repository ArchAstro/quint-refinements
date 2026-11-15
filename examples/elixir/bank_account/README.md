# Bank refinement, in Elixir

The tutorial's bank, checked from Elixir. The model is the same as the [Rust project's](../../rust/bank_account); the generated scenarios are identical, and so are the obligation counts and the divergence messages.

```console
# From the repository root:
npm ci
cd examples/elixir/bank_account
node ../../../packages/compiler/cli.mjs compile bank.qnt --elixir lib/generated_refinement.ex --check
mix run refine.exs
mix test
```

`compile --elixir` writes `quint-refinements.json` and `lib/generated_refinement.ex`. There is no Rust in this project.

```text
bank.qnt withdraw(4)
        -> quint-refinements.json
        -> generated ownership record "bank.withdraw"
        -> Bank.Adapter.withdraw(bank, [4]) -> Bank.withdraw(bank, 4)
        -> snapshot{balance: 6}
        -> generated guard and next-state checks
```

`test/bank_test.exs` also runs a bank that forgets to take the money out and checks that the checker reports `state.balance expected Int(6), observed Int(10)`, and it runs the shared conformance cases `bank_withdraw` and `bank_withdraw_v2`.

From the repository root, `npm run generate` rewrites the generated files after a model change and `npm run check:generated` fails when they no longer match `bank.qnt`.
