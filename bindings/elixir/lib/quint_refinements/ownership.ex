defmodule QuintRefinements.Ownership do
  @moduledoc """
  Which implementation command owns which Quint actions.

  An ownership record names one implementation command (`:primitive`) and the
  Quint actions it refines:

    * `:refines` is the ordered spec tape of one execution. Length 1 is a normal
      command. Length N is one command that takes N spec steps without
      yielding, the only legal 1-to-N model.
    * `:aliases` are extra generated names for a 1-step refine. They are
      forbidden when `:refines` is a sequence.
    * `:actions` is the legacy independent-name list (each name is its own
      1-step run). Prefer `:refines` for new records.
    * `:observations` and `:retrieve` list the observation paths and expression
      dependencies the primitive makes available.

  Every key but `:primitive` is optional.
  """

  import QuintRefinements.Error, only: [fail: 1]

  @typedoc "An ownership record as an adapter declares it."
  @type ownership_record :: %{
          required(:primitive) => String.t(),
          optional(:refines) => [String.t()],
          optional(:aliases) => [String.t()],
          optional(:actions) => [String.t()],
          optional(:observations) => [String.t()],
          optional(:retrieve) => [String.t()]
        }

  @typedoc "One package's exported ownership records."
  @type table :: %{owner: String.t(), descriptors: [ownership_record()]}

  @typedoc "A runtime copy of an ownership record with its owning package name."
  @type descriptor :: %{
          owner: String.t(),
          primitive: String.t(),
          refines: [String.t()],
          aliases: [String.t()],
          actions: [String.t()],
          observations: [String.t()],
          retrieve: [String.t()]
        }

  @doc "Validates explicit ownership tables and sorts their records by primitive identifier."
  @spec collect([table()] | table()) :: [descriptor()]
  def collect(tables) do
    descriptors =
      for table <- List.wrap(tables), record <- table.descriptors do
        refines = Map.get(record, :refines, [])
        aliases = Map.get(record, :aliases, [])

        if String.trim(record.primitive) == "" do
          fail("ownership record owned by #{table.owner} has an empty primitive ID")
        end

        if length(refines) > 1 and aliases != [] do
          fail("primitive #{record.primitive} refines a sequence and cannot declare aliases")
        end

        %{
          owner: table.owner,
          primitive: record.primitive,
          refines: refines,
          aliases: aliases,
          actions: Enum.uniq(refines ++ aliases ++ Map.get(record, :actions, [])),
          observations: Map.get(record, :observations, []),
          retrieve: Map.get(record, :retrieve, [])
        }
      end

    sorted = Enum.sort_by(descriptors, & &1.primitive)

    sorted
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.each(fn [previous, current] ->
      if previous.primitive == current.primitive do
        fail("primitive ID #{current.primitive} is declared more than once")
      end
    end)

    sorted
  end
end
