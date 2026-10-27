# Bank refinement, in Go

The tutorial's bank, checked from Go. The model is the same as the [Rust project's](../../rust/bank_account); the generated scenarios are identical, and so are the obligation counts and the divergence messages.

```console
# From the repository root:
npm ci
cd examples/go/bank_account
node ../../../packages/compiler/cli.mjs compile bank.qnt --go generated_refinement.go --go-package main --check
go run .
go test ./...
```

`compile --go` writes `quint-refinements.json` and `generated_refinement.go`. There is no Rust in this project.

```text
bank.qnt withdraw(4)
        -> quint-refinements.json
        -> generated ownership record "bank.withdraw"
        -> adapter.Withdraw([4]) -> Bank.Withdraw(4)
        -> snapshot{balance: 6}
        -> generated guard and next-state checks
```

`bank_test.go` also runs a bank that forgets to take the money out and checks that the checker reports `state.balance expected Int(6), observed Int(10)`.

From the repository root, `npm run generate` rewrites the generated files after a model change and `npm run check:generated` fails when they no longer match `bank.qnt`.
