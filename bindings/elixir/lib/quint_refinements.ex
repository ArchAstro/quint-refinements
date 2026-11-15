defmodule QuintRefinements do
  @moduledoc """
  Check an Elixir implementation against a [Quint](https://quint.sh/) model.

  This is the runtime that `quint-refinements compile --elixir` generated
  adapters build on. It reads the same schema-v2 and v3 artifacts as the Rust,
  Go and TypeScript runtimes and reports the same obligation counts and
  divergence messages.

  ## The generated adapter

  `quint-refinements compile model.qnt --elixir lib/generated_refinement.ex`
  writes a module with an `Implementation` behaviour that has one callback per
  Quint action. Implement it for your own code, then run every scenario:

      defmodule BankAdapter do
        @behaviour Bank.GeneratedRefinement.Implementation

        alias QuintRefinements.{Access, Evidence, Value}

        @impl true
        def from_initial_state(initial), do: %Bank{balance: Access.as_int(Access.field(initial, "balance"))}

        @impl true
        def snapshot(bank), do: Evidence.state(Value.record(balance: Value.int(bank.balance)))

        @impl true
        def withdraw(bank, [amount]), do: Bank.withdraw(bank, Access.as_int(amount))
      end

      for result <- Bank.GeneratedRefinement.refine_all(BankAdapter) do
        IO.puts("\#{result.scenario} refined \#{result.evaluated_obligations} obligations")
      end

  A divergence raises a `QuintRefinements.Error`.

  ## Modules

    * `QuintRefinements.Value` - normalized Quint values and their constructors
    * `QuintRefinements.Access` - typed readers for those values
    * `QuintRefinements.Evidence` - what a snapshot shows the checker
    * `QuintRefinements.Fixtures` - Quint constants backed by production values
    * `QuintRefinements.Artifact` - the generated scenarios
    * `QuintRefinements.Ownership` and `QuintRefinements.Schedule` - which
      command runs which actions
    * `QuintRefinements.Drive` - the runners
    * `QuintRefinements.Evaluate` - the obligation evaluator, for a tape
      collected some other way
  """

  alias QuintRefinements.{Artifact, Drive}

  @doc "Parses a generated artifact. See `QuintRefinements.Artifact.parse!/1`."
  @spec parse_artifact!(binary()) :: Artifact.t()
  defdelegate parse_artifact!(source), to: Artifact, as: :parse!

  @doc "The identifier of a scenario: `module.name`."
  @spec scenario_id(Artifact.scenario()) :: String.t()
  defdelegate scenario_id(scenario), to: Artifact

  @doc "Refines one scenario. See `QuintRefinements.Drive.refine_scenario/7`."
  defdelegate refine_scenario(scenario, init, ownership, retrieve, fixtures, driver, implementation), to: Drive
end
