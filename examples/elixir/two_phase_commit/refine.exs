# Checks an Elixir two-phase commit coordinator against model.qnt, with one
# commit/2 owning three Quint actions and the status universe bound to a
# production value.
#
# Regenerate the adapter with:
#   node ../../../packages/compiler/cli.mjs compile model.qnt --elixir lib/generated_refinement.ex
#
# Run with `mix run refine.exs`.
try do
  for result <-
        TwoPhaseCommit.GeneratedRefinement.refine_all(Coordinator,
          fixtures: &Coordinator.fixtures/1
        ) do
    IO.puts("#{result.scenario} refined #{result.evaluated_obligations} obligations")
  end
rescue
  error in QuintRefinements.Error ->
    IO.puts(:stderr, "two-phase commit refinement failed: #{error.message}")
    System.halt(1)
end
