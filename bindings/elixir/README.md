# quint-refinements for Elixir

Check an Elixir implementation against a [Quint](https://quint.sh/) model.

This is the runtime. It drives your implementation through scenarios generated
from the model and evaluates every generated guard and next-state obligation
against the snapshots your code returns. It reads the same schema-v2 and v3
artifacts as the Rust crate, the Go module and the TypeScript runtime, and
reports the same obligations and the same divergence messages. It has no
dependencies, and Quint integers are Elixir integers.

It needs Elixir 1.17 or newer on OTP 27 or newer (it decodes JSON with OTP's
`:json`). Add it to `mix.exs`:

```elixir
{:quint_refinements, github: "ArchAstro/quint-refinements", sparse: "bindings/elixir", only: :test}
```

Generate the adapter with the compiler, which is a Node.js program:

```console
npx quint-refinements compile model.qnt --elixir test/support/generated_refinement.ex
```

Then implement the generated `Implementation` behaviour for your own code:

```elixir
defmodule Bank.Adapter do
  @behaviour Bank.GeneratedRefinement.Implementation

  alias QuintRefinements.{Access, Evidence, Value}

  @impl true
  def from_initial_state(initial), do: %Bank{balance: Access.as_int(Access.field(initial, "balance"))}

  @impl true
  def snapshot(bank), do: Evidence.state(Value.record(balance: Value.int(bank.balance)))

  @impl true
  def withdraw(bank, [amount]), do: Bank.withdraw!(bank, Access.as_int(amount))
end

for result <- Bank.GeneratedRefinement.refine_all(Bank.Adapter) do
  IO.puts("#{result.scenario} refined #{result.evaluated_obligations} obligations")
end
```

A divergence raises a `QuintRefinements.Error`. The repository
[documentation](https://archastro.github.io/quint-refinements/reference/elixir)
covers the generated behaviour, values, snapshots and fixtures.

To drive scenarios yourself, use `QuintRefinements.Drive.refine_scenario/7`,
`run_refined_actions/6`, or a step-by-step `QuintRefinements.Drive.Session`
with the generated `ownership/0` and `retrieve/0` tables.

## Layout

1. `lib/` is the runtime: one module per concern (`Value`, `Evidence`,
   `Artifact`, `Ownership`, `Schedule`, `Fixtures`, `Evaluate`, `Drive`).
2. `test/` has one test file per runtime module, run with `mix test`.
3. The shared cases in `conformance/cases` run against the examples in
   `examples/elixir`: `bank_withdraw` and `bank_withdraw_v2` in
   `examples/elixir/bank_account/test/bank_test.exs`, and `two_phase_commit` in
   `examples/elixir/two_phase_commit/test/coordinator_test.exs`.
