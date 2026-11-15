defmodule QuintRefinements.Schedule do
  @moduledoc """
  Turns a scenario's generated actions into the implementation commands that
  must run, using the ownership records.
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.{Artifact, Evidence, Ownership}

  @typedoc "One implementation command the driver must run, and the Quint actions it fills."
  @type run :: %{primitive: String.t(), owned_actions: [String.t()]}

  @doc "Action names from the generated scenario, in JSON order."
  @spec scenario_action_names(Artifact.scenario()) :: [String.t()]
  def scenario_action_names(scenario), do: scenario |> Artifact.action_steps() |> Enum.map(& &1.action)

  defp fit(%{refines: [_ | _] = refines, aliases: aliases}, [first | _] = remaining) do
    cond do
      List.starts_with?(remaining, refines) -> if length(refines) > 1, do: :compound, else: :singleton
      length(refines) > 1 and Enum.take(remaining, 2) == Enum.take(refines, 2) -> :partial_compound
      first in aliases -> :singleton
      true -> nil
    end
  end

  defp fit(%{refines: [], actions: actions}, [first | _]), do: if(first in actions, do: :singleton)

  defp unique([], _action), do: nil
  defp unique([record], _action), do: record

  defp unique(records, action) do
    fail("JSON action #{action} is owned by multiple primitives (#{Enum.map_join(records, ", ", & &1.primitive)})")
  end

  @doc """
  Walks generated actions against ownership records.

  `:refines` is the ordered spec tape of one implementation command. JSON must
  present that sequence intact. Aliases are extra names for a 1-step refine.
  Legacy `:actions` lists (no `:refines`) stay independent 1-step runs.
  """
  @spec primitive_runs([String.t()], [Ownership.descriptor()]) :: [run()]
  def primitive_runs(json_actions, ownership), do: schedule(json_actions, ownership, [])

  defp schedule([], _ownership, runs), do: Enum.reverse(runs)

  defp schedule([first | rest] = remaining, ownership, runs) do
    fits = Enum.group_by(ownership, &fit(&1, remaining))

    case unique(Map.get(fits, :compound, []), first) do
      nil ->
        case Map.get(fits, :partial_compound, []) do
          [partial | _] ->
            shown = Enum.take(remaining, min(length(partial.refines), length(remaining)))

            fail(
              "primitive #{partial.primitive} JSON actions [#{Enum.join(shown, ", ")}] are not the owned sequence " <>
                "[#{Enum.join(partial.refines, ", ")}]"
            )

          [] ->
            case unique(Map.get(fits, :singleton, []), first) do
              nil -> fail("JSON action #{first} has no ownership record")
              singleton -> schedule(rest, ownership, [%{primitive: singleton.primitive, owned_actions: [first]} | runs])
            end
        end

      compound ->
        run = %{primitive: compound.primitive, owned_actions: compound.refines}
        schedule(Enum.drop(remaining, length(compound.refines)), ownership, [run | runs])
    end
  end

  @doc "Checks that a primitive returned one evidence snapshot per owned action, then appends them."
  @spec extend_validated_tape([Evidence.t()], run(), [Evidence.t()]) :: [Evidence.t()]
  def extend_validated_tape(snapshots, run, tape) do
    if length(tape) != length(run.owned_actions) do
      fail(
        "primitive #{run.primitive} owns #{length(run.owned_actions)} actions but returned " <>
          "#{length(tape)} evidence snapshots"
      )
    end

    snapshots ++ tape
  end

  @doc """
  Builds init plus one retrieve-after snapshot per JSON action. `run_primitive`
  runs the implementation command for one scheduled tape and must return
  exactly one evidence per owned action, in that order.
  """
  @spec collect_owned_action_snapshots(
          Artifact.scenario(),
          Evidence.t(),
          [Ownership.descriptor()],
          (String.t(), [String.t()] -> [Evidence.t()])
        ) :: [Evidence.t()]
  def collect_owned_action_snapshots(scenario, init, ownership, run_primitive) do
    scenario
    |> scenario_action_names()
    |> primitive_runs(ownership)
    |> Enum.reduce([init], fn run, snapshots ->
      extend_validated_tape(snapshots, run, run_primitive.(run.primitive, run.owned_actions))
    end)
  end
end
