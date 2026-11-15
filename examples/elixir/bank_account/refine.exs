# Checks an Elixir bank against the Quint model in bank.qnt.
#
# Regenerate the adapter with:
#   node ../../../packages/compiler/cli.mjs compile bank.qnt --elixir lib/generated_refinement.ex
#
# Run with `mix run refine.exs`.
try do
  for result <- Bank.GeneratedRefinement.refine_all(Bank.Adapter) do
    IO.puts(
      "#{result.scenario} refined #{result.evaluated_obligations} obligations; " <>
        "final balance #{result.implementation.balance}"
    )
  end
rescue
  error in QuintRefinements.Error ->
    IO.puts(:stderr, "bank refinement failed: #{error.message}")
    System.halt(1)
end
