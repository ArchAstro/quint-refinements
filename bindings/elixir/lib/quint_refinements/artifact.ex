defmodule QuintRefinements.Artifact do
  @moduledoc """
  The conformance artifact (schema v2 or v3) exported from the Quint model.

  Schema v3 stores each distinct list of obligations once in `assertionLists`
  and a step names its `guardList` and `nextList` by index. Parsing resolves
  those references, so every action step carries its own `guards` and `next`
  whichever schema the file used.
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.{Json, Vocabulary}

  @typedoc "Whether an assertion is supplied by a runtime adapter or extracted from the model."
  @type scope :: :runtime | :model

  @typedoc "One obligation: the normalized expression tree the evaluator interprets, and what it reads."
  @type assertion :: %{scope: scope(), expression: Json.t(), dependencies: [String.t()]}

  @typedoc "An initializer step that precedes all implementation actions."
  @type init_step :: %{kind: :init, index: non_neg_integer(), action: String.t(), arguments: [Json.t()]}

  @typedoc "A model action owned by an implementation primitive."
  @type action_step :: %{
          kind: :action,
          index: non_neg_integer(),
          action: String.t(),
          arguments: [Json.t()],
          guards: [assertion()],
          next: [assertion()]
        }

  @typedoc "An observation-only step evaluated against the current snapshot."
  @type observe_step :: %{kind: :observe, index: non_neg_integer(), assertions: [assertion()]}

  @type step :: init_step() | action_step() | observe_step()

  @typedoc """
  One ordered conformance scenario. `initial_state` is the complete generated
  initial model state (ITF JSON), or `nil` when full refinement is not enabled
  for the scenario.
  """
  @type scenario :: %{
          source: String.t(),
          module: String.t(),
          fixture_namespace: String.t(),
          name: String.t(),
          required_capabilities: [String.t()],
          initial_state: Json.t() | nil,
          steps: [step()]
        }

  @typedoc "The closed vocabulary published by the trace generator."
  @type vocabulary :: %{
          actions: [String.t()],
          capabilities: [String.t()],
          expression_operators: [String.t()],
          expression_names: [String.t()],
          refinement_expression_operators: [String.t()],
          runtime_observation_dependencies: [String.t()],
          runtime_observation_dependency_digest: String.t()
        }

  @enforce_keys [:schema_version, :model_digest, :vocabulary, :fixtures, :scenarios]
  defstruct [:schema_version, :model_digest, :vocabulary, :fixtures, :scenarios]

  @type t :: %__MODULE__{
          schema_version: pos_integer(),
          model_digest: String.t(),
          vocabulary: vocabulary(),
          fixtures: %{optional(String.t()) => %{optional(String.t()) => Json.t()}},
          scenarios: [scenario()]
        }

  @first_supported_schema 2
  @latest_schema 3

  @doc "The stable scenario identifier used by the coverage report: `module.name`."
  @spec scenario_id(scenario()) :: String.t()
  def scenario_id(%{module: module, name: name}), do: "#{module}.#{name}"

  @doc "The action steps of a scenario, in order."
  @spec action_steps(scenario()) :: [action_step()]
  def action_steps(%{steps: steps}), do: Enum.filter(steps, &(&1.kind == :action))

  @doc """
  Parses the checked JSON artifact without interpreting Quint source. Fails
  closed on unknown fields, missing fields and a refinement vocabulary that
  differs from this evaluator's.
  """
  @spec parse!(binary()) :: t()
  def parse!(source) when is_binary(source) do
    artifact =
      try do
        source |> Json.decode!() |> decode_artifact()
      rescue
        error in QuintRefinements.Error -> fail("invalid refinement artifact: #{error.message}")
      end

    complete? = Enum.any?(artifact.scenarios, &(&1.initial_state != nil))

    if complete? and artifact.vocabulary.refinement_expression_operators != Vocabulary.operators() do
      fail("artifact refinement expression vocabulary differs from the Elixir evaluator")
    end

    artifact
  end

  # A strict JSON object reader: required fields must exist and any field that
  # is not read is rejected, like serde's `deny_unknown_fields`.

  defp object!(value, _name) when is_map(value), do: value
  defp object!(_value, name), do: fail("#{name} must be an object")

  defp finish!(object, name, read) do
    case Enum.find(Json.sorted_keys(object), &(&1 not in read)) do
      nil -> :ok
      key -> fail("unknown field `#{key}` in #{name}")
    end
  end

  defp required(object, key) do
    case Map.fetch(object, key) do
      {:ok, value} -> value
      :error -> fail("missing field `#{key}`")
    end
  end

  defp invalid(key, expected), do: fail("invalid field `#{key}`: expected #{expected}")

  defp string(object, key) do
    case required(object, key) do
      value when is_binary(value) -> value
      _other -> invalid(key, "a string")
    end
  end

  defp count(object, key) do
    case required(object, key) do
      # The other runtimes read these as machine integers; 2^53 - 1 is the bound they share.
      value when is_integer(value) and value >= 0 and value <= 9_007_199_254_740_991 -> value
      _other -> invalid(key, "an unsigned integer")
    end
  end

  # A `u32`, which is how Rust and Go read `schemaVersion`.
  defp version(object, key) do
    case count(object, key) do
      value when value <= 0xFFFFFFFF -> value
      _other -> invalid(key, "a 32-bit unsigned integer")
    end
  end

  defp strings(object, key, required?) do
    value = if required?, do: required(object, key), else: Map.get(object, key, [])
    if is_list(value) and Enum.all?(value, &is_binary/1), do: value, else: invalid(key, "an array of strings")
  end

  defp array(object, key) do
    case required(object, key) do
      value when is_list(value) -> value
      _other -> invalid(key, "an array")
    end
  end

  defp decode_vocabulary(value) do
    object = object!(value, "vocabulary")

    decoded = %{
      actions: strings(object, "actions", true),
      capabilities: strings(object, "capabilities", true),
      expression_operators: strings(object, "expressionOperators", true),
      expression_names: strings(object, "expressionNames", true),
      refinement_expression_operators: strings(object, "refinementExpressionOperators", false),
      runtime_observation_dependencies: strings(object, "runtimeObservationDependencies", true),
      runtime_observation_dependency_digest: string(object, "runtimeObservationDependencyDigest")
    }

    finish!(object, "vocabulary", ~w(
      actions capabilities expressionOperators expressionNames refinementExpressionOperators
      runtimeObservationDependencies runtimeObservationDependencyDigest
    ))

    decoded
  end

  defp decode_assertions(values) do
    Enum.map(values, fn value ->
      object = object!(value, "assertion")
      scope = string(object, "scope")
      expression = required(object, "expression")
      dependencies = strings(object, "dependencies", false)
      finish!(object, "assertion", ~w(scope expression dependencies))

      scope =
        case scope do
          "runtime" -> :runtime
          "model" -> :model
          other -> fail("unknown variant `#{other}`, expected `runtime` or `model`")
        end

      %{scope: scope, expression: expression, dependencies: dependencies}
    end)
  end

  defp resolve_list(%{lists: lists}, _field, reference)
       when is_integer(reference) and reference >= 0 and reference < length(lists) do
    Enum.at(lists, reference)
  end

  defp resolve_list(%{lists: lists}, field, reference) do
    shown = if is_binary(reference), do: reference, else: Json.to_string(reference)
    fail("`#{field}` #{shown} is out of range: the artifact has #{length(lists)} assertion lists")
  end

  defp decode_step(value, shared, scenario) do
    object = object!(value, "step")

    case string(object, "kind") do
      "init" ->
        step = %{
          kind: :init,
          index: count(object, "index"),
          action: string(object, "action"),
          arguments: array(object, "arguments")
        }

        finish!(object, "step", ~w(kind index action arguments))
        step

      "action" ->
        index = count(object, "index")
        action = string(object, "action")
        arguments = array(object, "arguments")
        finish!(object, "step", ~w(kind index action arguments guards next guardList nextList))
        inline? = Map.has_key?(object, "guards") or Map.has_key?(object, "next")
        referenced? = Map.has_key?(object, "guardList") or Map.has_key?(object, "nextList")

        if shared.version >= 3 and inline? do
          fail(
            "step #{index} of #{scenario} has inline `guards` or `next`; schema version #{shared.version} " <>
              "names them with `guardList` and `nextList`"
          )
        end

        if shared.version < 3 and referenced? do
          fail(
            "step #{index} of #{scenario} uses `guardList` or `nextList`, which need schema version 3, " <>
              "found #{shared.version}"
          )
        end

        %{
          kind: :action,
          index: index,
          action: action,
          arguments: arguments,
          guards: step_list(object, shared, "guardList", "guards"),
          next: step_list(object, shared, "nextList", "next")
        }

      "observe" ->
        index = count(object, "index")
        assertions = array(object, "assertions")
        finish!(object, "step", ~w(kind index assertions))
        %{kind: :observe, index: index, assertions: decode_assertions(assertions)}

      other ->
        fail("unknown variant `#{other}`, expected one of `init`, `action`, `observe`")
    end
  end

  defp step_list(object, shared, reference_key, inline_key) do
    case object do
      %{^reference_key => reference} -> resolve_list(shared, reference_key, reference)
      %{^inline_key => inline} when is_list(inline) -> decode_assertions(inline)
      %{^inline_key => _other} -> fail("invalid field `#{inline_key}`: expected an array")
      _neither -> []
    end
  end

  defp decode_scenario(value, shared) do
    object = object!(value, "scenario")
    source = string(object, "source")
    module = string(object, "module")
    fixture_namespace = string(object, "fixtureNamespace")
    name = string(object, "name")
    required_capabilities = strings(object, "requiredCapabilities", true)
    steps = array(object, "steps")

    finish!(object, "scenario", ~w(source module fixtureNamespace name requiredCapabilities initialState steps))

    initial_state =
      case Map.get(object, "initialState") do
        :null -> nil
        state -> state
      end

    %{
      source: source,
      module: module,
      fixture_namespace: fixture_namespace,
      name: name,
      required_capabilities: required_capabilities,
      initial_state: initial_state,
      steps: Enum.map(steps, &decode_step(&1, shared, "#{module}.#{name}"))
    }
  end

  defp decode_fixtures(value) when is_map(value) do
    if Enum.all?(Map.values(value), &is_map/1) do
      value
    else
      fail("invalid field `fixtures`: expected an object of objects")
    end
  end

  defp decode_fixtures(_value), do: fail("invalid field `fixtures`: expected an object")

  defp decode_artifact(root) do
    object = object!(root, "artifact")
    schema_version = version(object, "schemaVersion")
    model_digest = string(object, "modelDigest")
    vocabulary = required(object, "vocabulary")
    fixtures = decode_fixtures(required(object, "fixtures"))
    scenarios = array(object, "scenarios")
    finish!(object, "artifact", ~w(schemaVersion modelDigest vocabulary fixtures assertionLists scenarios))

    if schema_version < @first_supported_schema or schema_version > @latest_schema do
      fail(
        "unsupported schema version #{schema_version}; this runtime reads versions " <>
          "#{@first_supported_schema} to #{@latest_schema}"
      )
    end

    lists =
      case Map.fetch(object, "assertionLists") do
        :error ->
          []

        {:ok, _lists} when schema_version < 3 ->
          fail("`assertionLists` needs schema version 3, found #{schema_version}")

        {:ok, lists} when is_list(lists) ->
          Enum.map(lists, fn
            list when is_list(list) -> decode_assertions(list)
            _other -> fail("invalid field `assertionLists`: expected an array of arrays")
          end)

        {:ok, _other} ->
          fail("invalid field `assertionLists`: expected an array")
      end

    shared = %{version: schema_version, lists: lists}

    %__MODULE__{
      schema_version: schema_version,
      model_digest: model_digest,
      vocabulary: decode_vocabulary(vocabulary),
      fixtures: fixtures,
      scenarios: Enum.map(scenarios, &decode_scenario(&1, shared))
    }
  end
end
