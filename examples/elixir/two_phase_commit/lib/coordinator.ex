defmodule Coordinator do
  @moduledoc """
  A worked example: a client COMMIT is one Elixir function, while the Quint
  model still has three spec steps (write PREPARE, flush the WAL, write COMMIT).

  It is an in-memory stand-in for a Postgres transaction's prepare, flush and
  commit log. Everything that connects this file to model.qnt lives in
  lib/generated_refinement.ex, which `quint-refinements compile --elixir`
  derives from the model.
  """

  @behaviour TwoPhaseCommit.GeneratedRefinement.Implementation

  alias QuintRefinements.{Access, Evidence, Fixtures, Value}

  # The transaction statuses. They own the Quint `Status` constructors.
  @statuses [:Idle, :Open, :Prepared, :Committed, :Aborted]

  defstruct status: :Idle, wal: [], flushed: false

  @type status :: :Idle | :Open | :Prepared | :Committed | :Aborted
  @type t :: %__MODULE__{status: status(), wal: [String.t()], flushed: boolean()}

  @spec statuses() :: [status()]
  def statuses, do: @statuses

  @doc "Makes the Quint `statuses` universe this module's `statuses/0`, not a parallel test twin."
  @spec fixtures(term()) :: Fixtures.t()
  def fixtures(_artifact \\ nil) do
    members =
      for status <- @statuses do
        tag = Atom.to_string(status)
        {%{"tag" => tag, "value" => %{"#tup" => []}}, Value.text(tag)}
      end

    Fixtures.insert_set(Fixtures.new("two_phase_commit"), "statuses", members)
  end

  # Builds a coordinator from a scenario's generated initial state.
  @impl true
  def from_initial_state(initial) do
    %__MODULE__{
      status: initial |> Access.field("status") |> status_from_value(),
      wal: initial |> Access.field("wal") |> Access.as_list() |> Enum.map(&Access.as_text/1),
      flushed: initial |> Access.field("flushed") |> Access.as_bool()
    }
  end

  defp status_from_value({:variant, tag, _payload}), do: status_from_tag(tag)
  defp status_from_value(value), do: value |> Access.as_text() |> status_from_tag()

  defp status_from_tag(tag) do
    Enum.find(@statuses, &(Atom.to_string(&1) == tag)) ||
      raise QuintRefinements.Error, message: "unknown status #{tag}"
  end

  # What the refinement checker may observe.
  @impl true
  def snapshot(%__MODULE__{} = coordinator) do
    Evidence.state(
      Value.record(
        status: Value.text(Atom.to_string(coordinator.status)),
        flushed: Value.bool(coordinator.flushed),
        wal: Value.list(Enum.map(coordinator.wal, &Value.text/1))
      )
    )
  end

  @impl true
  def begin(%__MODULE__{status: :Idle} = coordinator, _arguments),
    do: %{coordinator | status: :Open}

  def begin(%__MODULE__{}, _arguments), do: raise("begin requires Idle")

  @impl true
  def abort(%__MODULE__{status: status} = coordinator, _arguments)
      when status in [:Open, :Prepared] do
    %{coordinator | status: :Aborted}
  end

  def abort(%__MODULE__{}, _arguments), do: raise("abort requires Open or Prepared")

  @doc """
  One client COMMIT. Internally prepare, flush, commit: the 1-to-N tape declared
  by `@primitive commit = [prepare, flushWal, commitPrepared]` in the model. It
  returns one snapshot after each of the three steps.
  """
  @impl true
  def commit(%__MODULE__{} = coordinator, _actions) do
    prepared = prepare(coordinator)
    flushed = flush_wal(prepared)
    committed = commit_prepared(flushed)
    {committed, [snapshot(prepared), snapshot(flushed), snapshot(committed)]}
  end

  defp prepare(%__MODULE__{status: :Open} = coordinator) do
    %{coordinator | status: :Prepared, wal: coordinator.wal ++ ["prepare"], flushed: false}
  end

  defp prepare(%__MODULE__{}), do: raise("prepare requires Open")

  defp flush_wal(%__MODULE__{status: :Prepared, flushed: false} = coordinator),
    do: %{coordinator | flushed: true}

  defp flush_wal(%__MODULE__{}), do: raise("flush requires unflushed Prepared")

  defp commit_prepared(%__MODULE__{status: :Prepared, flushed: true} = coordinator) do
    %{coordinator | status: :Committed, wal: coordinator.wal ++ ["commit"]}
  end

  defp commit_prepared(%__MODULE__{}), do: raise("commitPrepared requires flushed Prepared")
end
