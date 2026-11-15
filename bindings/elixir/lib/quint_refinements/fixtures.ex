defmodule QuintRefinements.Fixtures do
  @moduledoc """
  Named Quint fixtures backed by production values, one table per model module.

  A fixture owns one Quint name such as a constant (`limit`) or a universe set
  (`statuses`). It is a pair: the JSON shape expected in the generated artifact,
  and the corresponding evaluator value. Build the pair from the production
  value, not a test twin: `validate!/2` compares the JSON to the generated
  artifact, so field drift fails closed.
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.{Artifact, Evidence, Json, Value}

  @enforce_keys [:namespace]
  defstruct namespace: nil, values: %{}, json: %{}

  @type t :: %__MODULE__{
          namespace: String.t(),
          values: %{optional(String.t()) => Value.t()},
          json: %{optional(String.t()) => Json.t()}
        }

  @typedoc """
  One fixture: `{artifact_json, runtime_value}`. The JSON may be any
  JSON-compatible term: numbers, strings, booleans, lists and maps with string
  or atom keys.
  """
  @type fixture :: {term(), Value.t()}

  @doc "A Quint `int` fixture."
  @spec int(integer()) :: fixture()
  def int(value) when is_integer(value), do: {value, Value.int(value)}

  @doc "A Quint `str` fixture or unit constructor name."
  @spec text(binary()) :: fixture()
  def text(value) when is_binary(value), do: {value, Value.text(value)}

  @doc "Creates an empty table for a Quint module namespace."
  @spec new(String.t()) :: t()
  def new(namespace) when is_binary(namespace), do: %__MODULE__{namespace: namespace}

  @doc """
  Creates a table that gives every fixture in a namespace the value the Quint
  model defines for it.

  Use this when the model's constants are plain data. Follow it with `insert/3`
  or `insert_set/3` to hand a name to a production value instead, so that value
  is checked against the model.
  """
  @spec from_artifact(String.t(), Artifact.t()) :: t()
  def from_artifact(namespace, %Artifact{fixtures: fixtures}) do
    json = Map.get(fixtures, namespace, %{})

    values =
      for name <- Json.sorted_keys(json), into: %{} do
        {name, QuintRefinements.Error.wrap("fixture #{name}: ", fn -> Value.from_itf(json[name]) end)}
      end

    %__MODULE__{namespace: namespace, values: values, json: json}
  end

  @doc "Adds one named fixture value."
  @spec insert(t(), String.t(), fixture()) :: t()
  def insert(%__MODULE__{} = table, name, {artifact_json, value}) when is_binary(name) do
    %{
      table
      | values: Map.put(table.values, name, value),
        json: Map.put(table.json, name, Json.normalize(artifact_json))
    }
  end

  @doc "Adds one named finite set of fixture values."
  @spec insert_set(t(), String.t(), [fixture()]) :: t()
  def insert_set(%__MODULE__{} = table, name, members) when is_binary(name) and is_list(members) do
    json =
      members
      |> Enum.map(fn {artifact_json, _value} -> Json.normalize(artifact_json) end)
      |> Enum.sort_by(&Json.to_string/1)

    value = Value.set(Enum.map(members, fn {_artifact_json, value} -> value end))
    %{table | values: Map.put(table.values, name, value), json: Map.put(table.json, name, json)}
  end

  @doc "Looks up a fixture by its generated Quint name, returning `nil` when the table does not own it."
  @spec get(t(), String.t()) :: Value.t() | nil
  def get(%__MODULE__{values: values}, name), do: Map.get(values, name)

  @doc "Reports whether the table owns a generated Quint name."
  @spec contains_name?(t(), String.t()) :: boolean()
  def contains_name?(%__MODULE__{values: values}, name), do: Map.has_key?(values, name)

  @doc "All owned fixture names in deterministic order."
  @spec names(t()) :: [String.t()]
  def names(%__MODULE__{values: values}), do: values |> Map.keys() |> Enum.sort()

  @doc "Fixture names in generated retrieve-dependency form."
  @spec retrieve_names(t()) :: [String.t()]
  def retrieve_names(%__MODULE__{} = table), do: Enum.map(names(table), &"name:#{&1}")

  defp namespace_fixtures!(%__MODULE__{namespace: namespace}, %Artifact{fixtures: fixtures}) do
    case Map.fetch(fixtures, namespace) do
      {:ok, expected} -> expected
      :error -> fail("fixture namespace #{namespace} is missing from the artifact")
    end
  end

  defp diverged(name, artifact_json, owned) do
    fail("fixture #{name} JSON diverged: artifact #{Json.to_string(artifact_json)} rust #{Json.to_string(owned)}")
  end

  @doc """
  Requires owned entries to exist in the artifact with matching JSON. Extra
  artifact fixtures (other records in the same Quint module) are allowed.
  Record comparison is key-subset: the owned keys must exist on the Quint
  object with equal values, so `organization_id` versus `id` fails.
  """
  @spec validate_entries!(t(), Artifact.t()) :: :ok
  def validate_entries!(%__MODULE__{} = table, %Artifact{} = artifact) do
    expected = namespace_fixtures!(table, artifact)

    for name <- Json.sorted_keys(table.json) do
      owned = table.json[name]

      case Map.fetch(expected, name) do
        :error ->
          fail("artifact namespace #{table.namespace} is missing fixture #{name}")

        {:ok, artifact_json} ->
          if not json_matches?(owned, artifact_json, false), do: diverged(name, artifact_json, owned)
      end
    end

    :ok
  end

  @doc "Requires every JSON fixture in this namespace to have an owner with equal JSON."
  @spec validate!(t(), Artifact.t()) :: :ok
  def validate!(%__MODULE__{} = table, %Artifact{} = artifact), do: validate_selected!(table, artifact, [])

  @doc """
  Requires every namespace fixture to have an owner and validates normalized
  names only in the scenarios selected by this proof. An empty selection
  validates every scenario in the namespace.
  """
  @spec validate_selected!(t(), Artifact.t(), [String.t()]) :: :ok
  def validate_selected!(%__MODULE__{} = table, %Artifact{} = artifact, scenario_ids) do
    expected = namespace_fixtures!(table, artifact)
    artifact_names = Json.sorted_keys(expected)
    owned_names = Json.sorted_keys(table.json)

    if artifact_names != owned_names do
      fail(
        "fixture namespace #{table.namespace} names differ: artifact #{Value.debug_strings(artifact_names)} " <>
          "rust #{Value.debug_strings(owned_names)}"
      )
    end

    for name <- owned_names do
      # `false` and `:null` are fixture values too, so `owned` is bound here and not in a filter.
      owned = Map.fetch!(table.json, name)
      if not json_matches?(owned, expected[name], true), do: diverged(name, expected[name], owned)
    end

    vocabulary_names = MapSet.new(artifact.vocabulary.expression_names)

    for scenario <- artifact.scenarios,
        scenario.fixture_namespace == table.namespace,
        scenario_ids == [] or Artifact.scenario_id(scenario) in scenario_ids do
      validate_scenario_names!(scenario, table, vocabulary_names)
    end

    :ok
  end

  @doc "Resolves fixture names before consulting the live snapshot."
  @spec bind_evidence(t(), Evidence.t()) :: Evidence.t()
  def bind_evidence(%__MODULE__{} = table, %Evidence{} = snapshot) do
    Evidence.new(
      fn name -> get(table, name) || Evidence.resolve_name(snapshot, name) end,
      fn operator, arguments -> Evidence.resolve_call(snapshot, operator, arguments) end
    )
  end

  # Compares owned JSON with the artifact's. Lists match an artifact `#set`.
  # With `exact?`, objects must have identical key sets; otherwise the owned
  # object's keys need only be a subset.
  defp json_matches?(owned, artifact, exact?) do
    cond do
      Json.to_string(owned) == Json.to_string(artifact) ->
        true

      is_list(owned) ->
        case artifact do
          %{"#set" => members} when is_list(members) -> sorted_strings(owned) == sorted_strings(members)
          _other -> false
        end

      is_map(owned) and is_map(artifact) ->
        (not exact? or map_size(owned) == map_size(artifact)) and
          Enum.all?(owned, fn {key, value} ->
            case Map.fetch(artifact, key) do
              {:ok, artifact_value} -> json_matches?(value, artifact_value, exact?)
              :error -> false
            end
          end)

      true ->
        false
    end
  end

  defp sorted_strings(values), do: values |> Enum.map(&Json.to_string/1) |> Enum.sort()

  @doc "Free names in a normalized expression: those not bound by an enclosing lambda or let."
  @spec expression_names(Json.t() | nil, MapSet.t(String.t())) :: [String.t()]
  def expression_names(expression, bound \\ MapSet.new()) do
    case Json.kind_of(expression) do
      "name" ->
        case Json.field(expression, "value") do
          name when is_binary(name) -> if MapSet.member?(bound, name), do: [], else: [name]
          _other -> []
        end

      "call" ->
        case Json.field(expression, "arguments") do
          arguments when is_list(arguments) -> Enum.flat_map(arguments, &expression_names(&1, bound))
          _other -> []
        end

      "lambda" ->
        parameters =
          case Json.field(expression, "parameters") do
            parameters when is_list(parameters) -> Enum.filter(parameters, &is_binary/1)
            _other -> []
          end

        optional_names(Json.field(expression, "body"), Enum.into(parameters, bound))

      "let" ->
        nested =
          case Json.field(expression, "name") do
            name when is_binary(name) -> MapSet.put(bound, name)
            _other -> bound
          end

        optional_names(Json.field(expression, "value"), bound) ++ optional_names(Json.field(expression, "body"), nested)

      _other ->
        []
    end
  end

  defp optional_names(nil, _bound), do: []
  defp optional_names(expression, bound), do: expression_names(expression, bound)

  defp validate_scenario_names!(scenario, table, vocabulary_names) do
    for %{kind: :action} = step <- scenario.steps,
        assertion <- step.guards ++ step.next,
        name <- expression_names(assertion.expression),
        name != "state" and not contains_name?(table, name) and not MapSet.member?(vocabulary_names, name) do
      fail(
        "#{Artifact.scenario_id(scenario)}:#{step.action} names #{name} but neither fixtures nor snapshot state own it"
      )
    end

    :ok
  end
end
