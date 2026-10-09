# Documentation

Read these in order the first time. Each guide builds a complete project that CI compiles and runs, so the code you see is the code that passes.

| | Page | You build | You learn |
|---|---|---|---|
| 1 | [Tutorial](tutorial.md) | A bank account | The whole loop: model, compile, implement, catch a bug |
| 2 | [Constants, branching, two files](guides/shop-orders.md) | A shop | Named constants, `if`/`else` actions, splitting the model |
| 3 | [One command, several actions](guides/one-command-many-actions.md) | A transaction commit | `@primitive`, intermediate snapshots, binding constants to Rust |
| 4 | [CI](guides/ci.md) | A workflow | `compile --check`, generating into an existing crate |

Reference:

1. [How it works](how-it-works.md): what is generated, what is checked, how to read a failure.
2. [Troubleshooting](troubleshooting.md): every message, what it means, what to change.
3. [Command reference](../README.md#command-reference).
4. [Rust API](https://docs.rs/quint-refinements).

Finished projects: [`bank_account`](../examples/rust/bank_account), [`shop_orders`](../examples/rust/shop_orders), [`transaction_commit`](../examples/rust/transaction_commit).
