defmodule QuintRefinements.Evaluate do
  @moduledoc """
  The obligation evaluator: it interprets the normalized expression trees in an
  artifact against the evidence an implementation returned.

  Most callers use `QuintRefinements.Drive`, which runs the implementation and
  calls into this module. The functions here are for a tape of snapshots that
  was collected some other way.
  """

  import QuintRefinements.Error, only: [fail: 1, wrap: 2]

  alias QuintRefinements.{Artifact, Evidence, Json, Value}

  @typep environment :: %{optional(String.t()) => Value.t()}
  # `sink` is the key under which a capturing evaluation leaves the value its
  # `assign` computed; see `capture_assignment/4`.
  @typep eval :: %{current: Evidence.t(), before: Evidence.t(), after: Evidence.t(), sink: reference() | nil}

  defp all_same(evidence), do: %{current: evidence, before: evidence, after: evidence, sink: nil}

  defp resolve_name!(evidence, name) do
    Evidence.resolve_name(evidence, name) || fail("unknown evidence name #{name}")
  end

  @doc """
  Resolves one generated action's Quint arguments against hydrated fixtures and
  the current scenario state.
  """
  @spec action_arguments(Artifact.step(), Evidence.t()) :: [Value.t()]
  def action_arguments(%{kind: :action} = step, evidence) do
    eval = all_same(evidence)

    Enum.map(step.arguments, fn argument ->
      wrap("#{step.action} argument: ", fn -> evaluate(argument, eval, %{}) end)
    end)
  end

  def action_arguments(_step, _evidence), do: fail("only action steps have runtime arguments")

  @doc """
  Evaluates every non-model assertion in a checked scenario's observe steps.

  Evaluation fails closed when an assertion references a dependency outside the
  adapter's declared registry or uses unsupported normalized syntax.
  """
  @spec runtime_assertions(Artifact.scenario(), Evidence.t(), [String.t()]) :: pos_integer()
  def runtime_assertions(scenario, evidence, supported_dependencies) do
    id = Artifact.scenario_id(scenario)

    evaluated =
      for %{kind: :observe} = step <- scenario.steps, reduce: 0 do
        evaluated ->
          evaluated + assertions(id, "observe", step.assertions, all_same(evidence), supported_dependencies, true)
      end

    if evaluated == 0, do: fail("#{id} evaluated no runtime assertions")
    evaluated
  end

  @doc """
  Evaluates guard assertions on the retrieve-before snapshot and next-state
  assertions on the retrieve-after snapshot for one action step. Model-scope
  conjuncts are skipped. Prefer `all_step_obligations/7` once the scenario's
  Quint names have fixture owners.
  """
  @spec step_obligations(
          String.t(),
          String.t(),
          [Artifact.assertion()],
          [Artifact.assertion()],
          Evidence.t(),
          Evidence.t(),
          [String.t()]
        ) :: non_neg_integer()
  def step_obligations(scenario_name, action, guards, next, before, after_, retrieve) do
    obligations(scenario_name, action, guards, next, before, after_, retrieve, true)
  end

  @doc "Like `step_obligations/7`, but every guard and next conjunct runs, model scope included."
  @spec all_step_obligations(
          String.t(),
          String.t(),
          [Artifact.assertion()],
          [Artifact.assertion()],
          Evidence.t(),
          Evidence.t(),
          [String.t()]
        ) :: non_neg_integer()
  def all_step_obligations(scenario_name, action, guards, next, before, after_, retrieve) do
    obligations(scenario_name, action, guards, next, before, after_, retrieve, false)
  end

  @doc "Evaluates each observe chapter's preceding action `next` against the same evidence used for that observe."
  @spec chapter_next(Artifact.scenario(), Evidence.t(), [String.t()]) :: non_neg_integer()
  def chapter_next(scenario, evidence, retrieve) do
    scenario.steps
    |> Enum.with_index()
    |> Enum.reduce(0, fn
      {%{kind: :observe}, index}, evaluated -> evaluated + preceding_action_next(scenario, index, evidence, retrieve)
      _other, evaluated -> evaluated
    end)
  end

  @doc "Evaluates `next` on the last action before `observe_index`."
  @spec preceding_action_next(Artifact.scenario(), non_neg_integer(), Evidence.t(), [String.t()]) :: non_neg_integer()
  def preceding_action_next(scenario, observe_index, evidence, retrieve) do
    preceding = scenario.steps |> Enum.take(observe_index) |> Enum.reverse() |> Enum.find(&(&1.kind == :action))

    case preceding do
      nil -> 0
      %{next: []} -> 0
      step -> step_obligations(Artifact.scenario_id(scenario), step.action, [], step.next, evidence, evidence, retrieve)
    end
  end

  @doc """
  The strict fake-domain loop: the first snapshot is retrieve-before the first
  action and snapshot `i + 1` is retrieve-after action `i`. It fails if the
  snapshot count is not the action count plus one. Model-scope conjuncts are
  skipped.
  """
  @spec every_action_step(Artifact.scenario(), [Evidence.t()], [String.t()]) :: non_neg_integer()
  def every_action_step(scenario, snapshots, retrieve), do: action_step_obligations(scenario, snapshots, retrieve, true)

  @doc """
  Like `every_action_step/3`, but every guard and next conjunct runs.
  Fixture-backed names belong on `retrieve` as `name:<fixture>`.
  """
  @spec all_action_steps(Artifact.scenario(), [Evidence.t()], [String.t()]) :: non_neg_integer()
  def all_action_steps(scenario, snapshots, retrieve), do: action_step_obligations(scenario, snapshots, retrieve, false)

  @doc """
  Evaluates a complete scenario as a reducer over its generated action tape.

  The generated Quint initial state is hydrated once. Each generated action
  assignment advances that hydrated state; implementation evidence overlays
  only the state fields claimed by the retrieve contract. Pre-guards evaluate
  before the assignment and the implementation action, while assignment guards
  and every `next` conjunct evaluate against the merged state after it.
  """
  @spec projected_action_steps(Artifact.scenario(), [Evidence.t()], [String.t()]) :: pos_integer()
  def projected_action_steps(scenario, snapshots, retrieve) do
    {evaluated, _state} = reduce_projected(scenario, snapshots, retrieve, true)
    evaluated
  end

  @doc "Evaluates final scenario observations against the same accumulated state produced by the action reducer."
  @spec projected_runtime_assertions(Artifact.scenario(), [Evidence.t()], [String.t()], [String.t()]) :: pos_integer()
  def projected_runtime_assertions(scenario, snapshots, retrieve, supported_dependencies) do
    id = Artifact.scenario_id(scenario)
    action_total = length(Artifact.action_steps(scenario))

    if length(snapshots) != action_total + 1 do
      fail("#{id} has #{action_total} actions but #{length(snapshots)} snapshots")
    end

    {_action_count, evaluated} =
      Enum.reduce(scenario.steps, {0, 0}, fn
        %{kind: :action}, {action_count, evaluated} ->
          {action_count + 1, evaluated}

        %{kind: :observe} = step, {action_count, evaluated} ->
          state = projected_prefix_state(scenario, Enum.take(snapshots, action_count + 1), retrieve, action_count)
          chapter = %{scenario | steps: [step]}
          evidence = projected(Enum.at(snapshots, action_count), state)
          {action_count, evaluated + runtime_assertions(chapter, evidence, supported_dependencies)}

        _init, counts ->
          counts
      end)

    if evaluated == 0, do: fail("#{id} evaluated no runtime assertions")
    evaluated
  end

  @doc "The accumulated model state after the first `action_count` actions."
  @spec projected_prefix_state(Artifact.scenario(), [Evidence.t()], [String.t()], non_neg_integer()) :: Value.t()
  def projected_prefix_state(scenario, snapshots, retrieve, action_count) do
    {steps, _retained} =
      Enum.reduce(scenario.steps, {[], 0}, fn
        %{kind: :init} = step, {steps, retained} -> {[step | steps], retained}
        %{kind: :action} = step, {steps, retained} when retained < action_count -> {[step | steps], retained + 1}
        _other, kept -> kept
      end)

    {_evaluated, state} = reduce_projected(%{scenario | steps: Enum.reverse(steps)}, snapshots, retrieve, false)
    state
  end

  @doc "Evaluates the guards that do not assign state, before the implementation action runs."
  @spec projected_pre_guards(Artifact.scenario(), non_neg_integer(), Value.t(), Evidence.t(), [String.t()]) ::
          non_neg_integer()
  def projected_pre_guards(scenario, action_index, state, snapshot, retrieve) do
    id = Artifact.scenario_id(scenario)
    step = Enum.at(Artifact.action_steps(scenario), action_index) || fail("#{id} has no action #{action_index}")
    pre_guards = Enum.reject(step.guards, &contains_assignment?(&1.expression))
    before = projected(snapshot, state)
    assertions("#{id}:#{step.action}", "pre-guard", pre_guards, all_same(before), retrieve, false)
  end

  defp reduce_projected(scenario, snapshots, retrieve, require_obligations?) do
    id = Artifact.scenario_id(scenario)
    actions = Artifact.action_steps(scenario)

    if length(snapshots) != length(actions) + 1 do
      fail(
        "#{id} has #{length(actions)} actions but #{length(snapshots)} snapshots " <>
          "(want init plus one after each action)"
      )
    end

    if scenario.initial_state == nil, do: fail("#{id} has no complete initial state")
    state = wrap("#{id} initial state: ", fn -> Value.from_itf(scenario.initial_state) end)
    initial_observed = wrap("#{id} init state evidence: ", fn -> resolve_name!(hd(snapshots), "state") end)

    case structural_difference(state, initial_observed, "state") do
      nil -> :ok
      difference -> fail("#{id} Rust fixture does not match Quint initial state: #{difference}")
    end

    {evaluated, state} =
      actions
      |> Enum.zip(Enum.chunk_every(snapshots, 2, 1, :discard))
      |> Enum.reduce({0, state}, fn {action, [before, after_]}, {evaluated, state} ->
        {step_evaluated, state} =
          projected_action_step(id, action.action, action.guards, action.next, state, before, after_, retrieve)

        {evaluated + step_evaluated, state}
      end)

    if require_obligations? and evaluated == 0, do: fail("#{id} evaluated no action obligations")
    {evaluated, state}
  end

  @doc """
  Evaluates one complete action: pre-guards, the model's state assignment, the
  merge with the implementation's observed fields, then post-guards and every
  `next` conjunct against the merged state. Returns the number of obligations
  evaluated and the merged state.
  """
  @spec projected_action_step(
          String.t(),
          String.t(),
          [Artifact.assertion()],
          [Artifact.assertion()],
          Value.t(),
          Evidence.t(),
          Evidence.t(),
          [String.t()]
        ) :: {non_neg_integer(), Value.t()}
  def projected_action_step(scenario_name, action, guards, next, state, before_snapshot, after_snapshot, retrieve) do
    context = "#{scenario_name}:#{action}"
    before = projected(before_snapshot, state)
    {post_guards, pre_guards} = Enum.split_with(guards, &contains_assignment?(&1.expression))
    evaluated = assertions(context, "pre-guard", pre_guards, all_same(before), retrieve, false)

    {assignment_kind, assignment} =
      case post_guards do
        [guard | _] -> {"post-guard", guard}
        [] -> {"next", Enum.find(next, &contains_assignment?(&1.expression))}
      end

    if assignment == nil, do: fail("#{context} next: complete action has no state assignment")

    model_next =
      capture_assignment(context, assignment_kind, assignment, before, retrieve) ||
        fail("#{context} next: complete action has no state assignment")

    observed = wrap("#{context} state evidence: ", fn -> resolve_name!(after_snapshot, "state") end)

    observed_fields =
      for %{scope: :runtime, dependencies: dependencies} <- guards ++ next,
          "path:state." <> path <- dependencies,
          into: MapSet.new() do
        path |> String.split(".") |> hd()
      end

    wrap("#{context} state evidence: ", fn ->
      require_changed_observations(state, model_next, observed, observed_fields)
    end)

    merged_fields = MapSet.union(observed_state_fields(retrieve), observed_fields)
    merged = merge_observed_state(model_next, observed, merged_fields)
    after_ = projected(after_snapshot, merged)
    post = %{current: before, before: before, after: after_, sink: nil}
    evaluated = evaluated + assertions(context, "post-guard", post_guards, post, retrieve, false)
    evaluated = evaluated + assertions(context, "next", next, %{post | current: after_}, retrieve, false)
    {evaluated, merged}
  end

  # Evaluates the assigning conjunct with a sink: `assign` records the value the
  # model computes instead of comparing it with the implementation's. The
  # evaluator is a recursive interpreter, so the sink is a process dictionary
  # entry under a fresh reference rather than a value threaded through every
  # call; it is removed before this function returns.
  defp capture_assignment(context, kind, assignment, before, retrieve) do
    sink = make_ref()
    capture = %{current: before, before: before, after: before, sink: sink}

    try do
      assertions(context, kind, [assignment], capture, retrieve, false)
      Process.get({__MODULE__, sink})
    after
      Process.delete({__MODULE__, sink})
    end
  end

  # Evidence whose `state` is the reducer's accumulated state and whose other
  # names come from a snapshot.
  defp projected(snapshot, state) do
    Evidence.new(
      fn
        "state" -> state
        name -> Evidence.resolve_name(snapshot, name)
      end,
      fn operator, arguments -> projected_call(snapshot, state, operator, arguments) end
    )
  end

  @projected_collections %{
    "attemptValue" => "attempts",
    "connectionValue" => "connections",
    "deliveryValue" => "deliveries",
    "tokenValue" => "enrollment_tokens"
  }

  defp projected_call(_snapshot, state, "dedupEntry", [key]),
    do: projected_optional_map_value(state, "connector_dedup", key)

  defp projected_call(_snapshot, state, "dedupValue", [key]) do
    case projected_optional_map_value(state, "connector_dedup", key) do
      {:present, value} -> value
      :absent -> fail("projected connector_dedup entry is absent")
      value -> value
    end
  end

  defp projected_call(_snapshot, _state, "resultFor", [{:record, delivery}, outcome]) do
    read = fn name -> Map.get(delivery, name) || fail("deliveryValue has no #{name}") end

    Value.record(%{
      "attempt_id" => read.("attempt_id"),
      "delivery_id" => read.("id"),
      "org_id" => read.("org_id"),
      "service_spec_id" => read.("service_spec_id"),
      "service_id" => read.("service_id"),
      "connection_id" => read.("connection_id"),
      "outcome" => outcome
    })
  end

  defp projected_call(_snapshot, state, operator, [key]) when is_map_key(@projected_collections, operator) do
    projected_map_value(state, @projected_collections[operator], key)
  end

  defp projected_call(snapshot, _state, operator, arguments), do: Evidence.resolve_call(snapshot, operator, arguments)

  defp projected_optional_map_value({:record, fields}, field_name, key) do
    case Map.get(fields, field_name) do
      {:map, _} = values -> Value.map_get(values, key) || :absent
      _other -> fail("projected state has no map #{field_name}")
    end
  end

  defp projected_optional_map_value(_state, _field_name, _key), do: fail("projected state is not a record")

  defp projected_map_value({:record, fields}, field_name, key) do
    value =
      case {Map.get(fields, field_name), key} do
        {{:map, _} = collection, key} -> Value.map_get(collection, key)
        {{:record, collection}, {:text, name}} -> Map.get(collection, name)
        _other -> fail("projected state has no keyed collection #{field_name}")
      end

    case value do
      absent when absent in [nil, :absent] -> fail("projected #{field_name} has no value for #{Value.debug(key)}")
      {:present, value} -> value
      value -> value
    end
  end

  defp projected_map_value(_state, _field_name, _key), do: fail("projected state is not a record")

  defp observed_state_fields(retrieve) do
    for "path:state." <> path <- retrieve, into: MapSet.new(), do: path |> String.split(".") |> hd()
  end

  defp contains_assignment?(%{"kind" => "call", "operator" => "assign"}), do: true
  defp contains_assignment?(expression) when is_list(expression), do: Enum.any?(expression, &contains_assignment?/1)

  defp contains_assignment?(expression) when is_map(expression) do
    expression |> Map.values() |> Enum.any?(&contains_assignment?/1)
  end

  defp contains_assignment?(_expression), do: false

  @doc false
  # Exposed for tests of the merge alone.
  @spec merge_observed_state(Value.t(), Value.t(), MapSet.t(String.t())) :: Value.t()
  def merge_observed_state({:record, model}, {:record, observed}, fields) do
    merged =
      fields
      |> Enum.sort()
      |> Enum.reduce(model, fn name, merged ->
        case {Map.fetch(observed, name), Map.fetch(merged, name)} do
          {:error, _model_value} ->
            merged

          {{:ok, _value}, :error} ->
            fail("Rust action evidence contains field state.#{name} outside the hydrated Quint state")

          {{:ok, value}, {:ok, model_value}} ->
            Map.put(merged, name, merge_state_value(model_value, value))
        end
      end)

    {:record, merged}
  end

  def merge_observed_state({:record, _model}, _observed, _fields),
    do: fail("Rust action state evidence is not a record")

  def merge_observed_state(_model, _observed, _fields), do: fail("generated Quint state is not a record")

  defp require_changed_observations({:record, before}, {:record, model_next}, {:record, observed}, fields) do
    for name <- Enum.sort(fields) do
      changed? =
        case {Map.fetch(before, name), Map.fetch(model_next, name)} do
          {:error, :error} -> false
          {{:ok, left}, {:ok, right}} -> not Value.equal?(left, right)
          _one_missing -> true
        end

      if changed? and not Map.has_key?(observed, name) do
        fail("Rust action omitted changed runtime-owned field state.#{name}")
      end
    end

    :ok
  end

  defp require_changed_observations({:record, _}, {:record, _}, _observed, _fields) do
    fail("Rust action state evidence is not a record")
  end

  defp require_changed_observations(_before, _model_next, _observed, _fields) do
    fail("generated Quint state is not a record")
  end

  # Overlays observed state on the model's. A record's fields merge one by one
  # (evidence may leave out fields the model owns); a map's entries are the
  # observed ones: an entry the implementation lacks must not be filled in from
  # the model, or a dropped entry would go unnoticed.
  defp merge_state_value({:map, _} = accumulated, {:map, entries}) do
    Enum.reduce(entries, Value.map(), fn {key, value}, result ->
      Value.map_put(result, key, merge_existing(Value.map_get(accumulated, key), value))
    end)
  end

  defp merge_state_value({:map, _} = accumulated, {:record, _} = update) do
    Enum.reduce(Value.record_fields(update), Value.map(), fn {name, value}, result ->
      key = Value.text(name)
      Value.map_put(result, key, merge_existing(Value.map_get(accumulated, key), value))
    end)
  end

  defp merge_state_value({:record, accumulated}, {:record, update}) do
    {:record, Map.merge(accumulated, update, fn _name, existing, value -> merge_state_value(existing, value) end)}
  end

  defp merge_state_value({:list, accumulated}, {:list, update}) when length(accumulated) == length(update) do
    {:list, Enum.zip_with(accumulated, update, &merge_state_value/2)}
  end

  defp merge_state_value({:tuple, accumulated}, {:tuple, update}) when length(accumulated) == length(update) do
    {:tuple, Enum.zip_with(accumulated, update, &merge_state_value/2)}
  end

  defp merge_state_value({:variant, tag, accumulated}, {:variant, tag, update}) do
    {:variant, tag, merge_state_value(accumulated, update)}
  end

  defp merge_state_value({:present, accumulated}, {:present, update}),
    do: {:present, merge_state_value(accumulated, update)}

  defp merge_state_value(_accumulated, update), do: update

  defp merge_existing(nil, value), do: value
  defp merge_existing(existing, value), do: merge_state_value(existing, value)

  defp action_step_obligations(scenario, snapshots, retrieve, skip_model?) do
    id = Artifact.scenario_id(scenario)
    actions = Artifact.action_steps(scenario)

    if length(snapshots) != length(actions) + 1 do
      fail(
        "#{id} has #{length(actions)} actions but #{length(snapshots)} snapshots " <>
          "(want init plus one after each action)"
      )
    end

    actions
    |> Enum.zip(Enum.chunk_every(snapshots, 2, 1, :discard))
    |> Enum.reduce(0, fn {step, [before, after_]}, evaluated ->
      evaluated + obligations(id, step.action, step.guards, step.next, before, after_, retrieve, skip_model?)
    end)
  end

  defp obligations(_scenario_name, _action, [], [], _before, _after, _retrieve, _skip_model?), do: 0

  defp obligations(scenario_name, action, guards, next, before, after_, retrieve, skip_model?) do
    context = "#{scenario_name}:#{action}"
    eval = %{current: before, before: before, after: after_, sink: nil}

    evaluated =
      assertions(context, "guard", guards, eval, retrieve, skip_model?) +
        assertions(context, "next", next, %{eval | current: after_}, retrieve, skip_model?)

    if evaluated == 0, do: fail("#{context} declared step obligations but evaluated none")
    evaluated
  end

  @builtin_dependencies ~w(
    operator:eq operator:neq operator:not operator:actionAll operator:contains operator:field operator:get
    operator:assign
  )

  defp assertions(context, kind, assertions, eval, supported, skip_model?) do
    Enum.reduce(assertions, 0, fn
      %{scope: :model}, evaluated when skip_model? ->
        evaluated

      assertion, evaluated ->
        require_supported(context, kind, assertion.dependencies, supported)

        case wrap("#{context} #{kind}: ", fn -> evaluate(assertion.expression, eval, %{}) end) do
          {:bool, true} ->
            evaluated + 1

          {:bool, false} ->
            fail("#{kind} assertion evaluated false in #{context}: #{Json.to_string(assertion.expression)}")

          _other ->
            fail("#{kind} assertion did not evaluate to boolean in #{context}: #{Json.to_string(assertion.expression)}")
        end
    end)
  end

  defp require_supported(context, kind, dependencies, supported) do
    case Enum.find(dependencies, fn dependency -> not supported?(dependency, supported) end) do
      nil -> :ok
      dependency -> fail("#{context} #{kind} uses unsupported runtime dependency #{dependency}")
    end
  end

  defp supported?(dependency, _supported) when dependency in @builtin_dependencies, do: true
  defp supported?(dependency, supported), do: dependency in supported

  @doc "Evaluates one normalized expression tree. Exposed for tests of individual operators."
  @spec expression(Json.t(), Evidence.t(), %{optional(String.t()) => Value.t()}) :: Value.t()
  def expression(expression, evidence, environment \\ %{}), do: evaluate(expression, all_same(evidence), environment)

  @spec evaluate(Json.t() | nil, eval(), environment()) :: Value.t()
  defp evaluate(expression, eval, env) do
    case Json.kind_of(expression) do
      "bool" ->
        case expression["value"] do
          value when is_boolean(value) -> {:bool, value}
          _other -> fail("normalized boolean has no value")
        end

      "int" ->
        case expression["value"] do
          value when is_integer(value) -> {:int, value}
          _other -> fail("normalized integer has no value")
        end

      "str" ->
        case expression["value"] do
          value when is_binary(value) -> {:text, value}
          _other -> fail("normalized string has no value")
        end

      "name" ->
        evaluate_name(expression["value"], eval, env)

      "call" ->
        evaluate_call(expression, eval, env)

      "let" ->
        name = expression["name"]
        if not is_binary(name), do: fail("normalized let has no name")
        value = evaluate(expression["value"], eval, env)
        evaluate(expression["body"], eval, Map.put(env, name, value))

      _other ->
        fail("unsupported normalized expression kind")
    end
  end

  defp evaluate_name(name, _eval, _env) when not is_binary(name), do: fail("normalized name has no value")
  defp evaluate_name(name, _eval, env) when is_map_key(env, name), do: Map.fetch!(env, name)
  defp evaluate_name("disabled", _eval, _env), do: {:bool, false}

  defp evaluate_name("Absent", eval, _env) do
    Evidence.resolve_name(eval.current, "Absent") || :absent
  rescue
    QuintRefinements.Error -> :absent
  end

  defp evaluate_name(name, eval, _env), do: resolve_name!(eval.current, name)

  defp evaluate_call(expression, eval, env) do
    operator = expression["operator"]
    if not is_binary(operator), do: fail("normalized call has no operator")
    arguments = expression["arguments"]
    if not is_list(arguments), do: fail("normalized call has no arguments")

    case operator do
      "assign" -> evaluate_assign(arguments, eval, env)
      "matchVariant" -> evaluate_match_variant(arguments, eval, env)
      "filter" -> evaluate_filter(arguments, eval, env)
      operator when operator in ["map", "mapBy"] -> evaluate_map(operator, arguments, eval, env)
      "fold" -> evaluate_fold(arguments, eval, env)
      operator when operator in ["forall", "exists"] -> evaluate_quantifier(operator, arguments, eval, env)
      "ite" -> evaluate_ite(arguments, eval, env)
      operator when operator in ["and", "or", "actionAll", "actionAny"] -> short_circuit(operator, arguments, eval, env)
      operator -> evaluate_strict(operator, Enum.map(arguments, &evaluate(&1, eval, env)), eval)
    end
  end

  defp evaluate_strict(operator, values, eval) do
    cond do
      (builtin = common_call(operator, values)) != nil ->
        builtin

      (custom = Evidence.resolve_call(eval.current, operator, values)) != nil ->
        custom

      constructor?(operator) ->
        case values do
          [value] -> {:variant, operator, value}
          _other -> fail("variant constructor #{operator} requires one value, received #{length(values)}")
        end

      true ->
        fail("unsupported runtime operator #{operator} for #{Value.debug_values(values)}")
    end
  end

  # A name that starts with an uppercase character is a variant constructor.
  # Rust asks for the Unicode `Uppercase` property, which is the uppercase
  # letters plus characters such as `Ⓐ` that have a lowercase form.
  defp constructor?(operator) do
    case String.first(operator) do
      nil -> false
      first -> Regex.match?(~r/\A\p{Lu}/u, first) or (String.upcase(first) == first and String.downcase(first) != first)
    end
  end

  defp evaluate_assign([target, source], eval, env) do
    expected = evaluate(source, %{eval | current: eval.before}, env)

    if eval.sink do
      Process.put({__MODULE__, eval.sink}, expected)
      {:bool, true}
    else
      observed = evaluate(target, %{eval | current: eval.after}, env)

      case structural_difference(expected, observed, "state") do
        nil -> {:bool, true}
        difference -> fail("assign state diverged at #{difference}")
      end
    end
  end

  defp evaluate_assign(_arguments, _eval, _env), do: fail("assign requires a variable and an expression")

  # Evaluates the built-in operators. It returns `nil` when the operator and
  # argument shapes do not match; the caller then consults the evidence's own
  # calls.
  defp common_call("eq", [left, right]), do: {:bool, Value.equal?(left, right)}
  defp common_call("neq", [left, right]), do: {:bool, not Value.equal?(left, right)}
  defp common_call("not", [{:bool, value}]), do: {:bool, not value}
  defp common_call("Present", [value]), do: {:present, value}
  defp common_call("variant", [{:text, tag}, value]), do: {:variant, tag, value}
  defp common_call("List", values), do: {:list, values}
  defp common_call("Tup", values), do: {:tuple, values}
  defp common_call("Set", values), do: Value.set(values)
  defp common_call("Map", values), do: map_from_values(values)
  defp common_call("Rec", values), do: record_from_values(values)

  defp common_call("replicaPoolKey", [{:text, _} = replica, {:record, _} = pool]) do
    Value.record(%{"replica_id" => replica, "pool_key" => pool})
  end

  defp common_call("field", [{:record, fields}, {:text, name}]) do
    Map.get(fields, name) || fail("runtime record has no field #{name}")
  end

  defp common_call("get", [{:record, fields}, {:text, name}]), do: Map.get(fields, name, :absent)

  defp common_call("get", [{:map, _} = map, key]) do
    Value.map_get(map, key) || fail("map has no key #{Value.debug(key)}")
  end

  defp common_call("contains", [{:set, _} = set, member]), do: {:bool, Value.set_contains?(set, member)}
  defp common_call("length", [{:list, items}]), do: {:int, length(items)}
  defp common_call("size", [{kind, items}]) when kind in [:list, :tuple, :set, :map], do: {:int, length(items)}
  defp common_call("size", [{:record, fields}]), do: {:int, map_size(fields)}
  defp common_call("with", [{:record, _} = record, {:text, name}, value]), do: Value.record_put(record, name, value)
  defp common_call("set", [{:record, _} = record, {:text, name}, value]), do: Value.record_put(record, name, value)

  defp common_call("set", [{:map, _} = map, key, value]) do
    if Value.map_get(map, key) == nil, do: fail("set cannot add missing map key #{Value.debug(key)}")
    Value.map_put(map, key, value)
  end

  defp common_call("put", [{:map, _} = map, key, value]), do: Value.map_put(map, key, value)
  defp common_call("union", [{:set, left}, {:set, right}]), do: Value.set(left ++ right)

  defp common_call("exclude", [{:set, members}, {:set, _} = removed]) do
    {:set, Enum.reject(members, &Value.set_contains?(removed, &1))}
  end

  defp common_call("ilt", [{:int, left}, {:int, right}]), do: {:bool, left < right}
  defp common_call("igt", [{:int, left}, {:int, right}]), do: {:bool, left > right}
  defp common_call("ilte", [{:int, left}, {:int, right}]), do: {:bool, left <= right}
  defp common_call("igte", [{:int, left}, {:int, right}]), do: {:bool, left >= right}
  defp common_call("iadd", [{:int, left}, {:int, right}]), do: {:int, left + right}
  defp common_call("isub", [{:int, left}, {:int, right}]), do: {:int, left - right}
  defp common_call("append", [{:list, items}, value]), do: {:list, items ++ [value]}
  defp common_call("concat", [{:list, left}, {:list, right}]), do: {:list, left ++ right}
  defp common_call("indices", [{:list, []}]), do: {:set, []}
  defp common_call("indices", [{:list, items}]), do: {:set, Enum.map(0..(length(items) - 1), &{:int, &1})}

  defp common_call("nth", [{:list, items}, {:int, index}]) do
    if index < 0 or index >= length(items), do: fail("list index #{index} is out of bounds")
    Enum.at(items, index)
  end

  defp common_call("keys", [{:map, entries}]), do: {:set, Enum.map(entries, &elem(&1, 0))}
  defp common_call(_operator, _values), do: nil

  defp record_from_values(values) do
    if rem(length(values), 2) != 0, do: fail("Rec requires key and value pairs")

    # A repeated key keeps the last value, as inserting into a map does.
    values
    |> Enum.chunk_every(2)
    |> Map.new(fn
      [{:text, name}, value] -> {name, value}
      _other -> fail("Rec key is not text")
    end)
    |> Value.record()
  end

  defp map_from_values(values) do
    values
    |> Enum.map(fn
      {:tuple, [key, value]} -> {key, value}
      {:tuple, _items} -> fail("Map entries must contain exactly two values")
      _other -> fail("Map accepts only key/value tuples")
    end)
    |> Value.map()
  end

  @doc "Reports whether two values are the same, comparing as `structural_difference/3` does."
  @spec structurally_equal?(Value.t(), Value.t()) :: boolean()
  def structurally_equal?(expected, observed), do: structural_difference(expected, observed, "state") == nil

  @doc """
  Names the first place two values diverge, or returns `nil` when they are
  equal. Messages match the other bindings'.
  """
  @spec structural_difference(Value.t(), Value.t(), String.t()) :: String.t() | nil
  def structural_difference({:record, expected}, {:record, observed}, path) do
    if map_size(expected) != map_size(observed) do
      missing = expected |> Map.keys() |> Enum.reject(&Map.has_key?(observed, &1)) |> Enum.sort()
      unexpected = observed |> Map.keys() |> Enum.reject(&Map.has_key?(expected, &1)) |> Enum.sort()

      "#{path} record fields differ; missing #{Value.debug_strings(missing)}, " <>
        "unexpected #{Value.debug_strings(unexpected)}"
    else
      Enum.find_value(Value.record_fields({:record, expected}), fn {name, value} ->
        nested = "#{path}.#{name}"

        case Map.fetch(observed, name) do
          :error -> "#{nested} missing from observed state"
          {:ok, observed_value} -> structural_difference(value, observed_value, nested)
        end
      end)
    end
  end

  def structural_difference({:present, expected}, {:present, observed}, path) do
    structural_difference(expected, observed, path)
  end

  def structural_difference({:list, expected}, {:list, observed}, path) do
    if length(expected) != length(observed) do
      "#{path} expected list length #{length(expected)}, observed #{length(observed)}"
    else
      expected
      |> Enum.zip(observed)
      |> Enum.with_index()
      |> Enum.find_value(fn {{left, right}, index} -> structural_difference(left, right, "#{path}[#{index}]") end)
    end
  end

  def structural_difference({:map, expected_entries} = expected, {:map, observed_entries} = observed, path) do
    key_path = fn
      {:text, key} -> "#{path}[#{Value.debug_string(key)}]"
      {:int, key} -> "#{path}[#{key}]"
      key -> "#{path}[#{Value.debug(key)}]"
    end

    missing = Enum.find(expected_entries, fn {key, _} -> Value.map_get(observed, key) == nil end)
    unexpected = Enum.find(observed_entries, fn {key, _} -> Value.map_get(expected, key) == nil end)

    case {missing, unexpected} do
      {{key, _}, _unexpected} ->
        "#{key_path.(key)} missing from observed state"

      {nil, {key, _}} ->
        "#{key_path.(key)} unexpected in observed state"

      {nil, nil} ->
        Enum.find_value(expected_entries, fn {key, value} ->
          structural_difference(value, Value.map_get(observed, key), key_path.(key))
        end)
    end
  end

  def structural_difference(expected, observed, path) do
    if Value.equal?(expected, observed) do
      nil
    else
      "#{path} expected #{Value.debug(expected)}, observed #{Value.debug(observed)}"
    end
  end

  # Quint's `and` and `or` stop at the first argument that decides the result,
  # so a later argument may rely on an earlier one, as in
  # `l.length() > i and l[i] == x`.
  defp short_circuit(operator, arguments, eval, env) do
    decisive = operator in ["or", "actionAny"]

    decided? =
      Enum.any?(arguments, fn argument ->
        case evaluate(argument, eval, env) do
          {:bool, value} -> value == decisive
          _other -> fail("#{operator} accepts only normalized booleans")
        end
      end)

    {:bool, if(decided?, do: decisive, else: not decisive)}
  end

  defp evaluate_ite([condition, consequent, alternative], eval, env) do
    case evaluate(condition, eval, env) do
      {:bool, true} -> evaluate(consequent, eval, env)
      {:bool, false} -> evaluate(alternative, eval, env)
      _other -> fail("ite condition is not boolean")
    end
  end

  defp evaluate_ite(_arguments, _eval, _env), do: fail("ite requires a condition and two branches")

  defp lambda?(value), do: Json.kind_of(value) == "lambda"

  defp first_parameter(lambda) do
    case Json.field(lambda, "parameters") do
      [name | _] when is_binary(name) -> name
      _other -> nil
    end
  end

  defp evaluate_quantifier(operator, [collection, lambda], eval, env) do
    items =
      case evaluate(collection, eval, env) do
        {kind, items} when kind in [:set, :list, :tuple] -> items
        {:map, entries} -> Enum.map(entries, &elem(&1, 1))
        {:record, _} = record -> record |> Value.record_fields() |> Enum.map(&elem(&1, 1))
        _other -> fail("#{operator} input is not a collection")
      end

    if not lambda?(lambda), do: fail("#{operator} predicate is not a lambda")
    parameter = first_parameter(lambda) || fail("#{operator} lambda has no parameter")
    body = Json.field(lambda, "body")

    # Every member is evaluated, so a predicate that is not boolean for a later
    # member is reported even when an earlier one already decides the result.
    results =
      Enum.map(items, fn item ->
        case evaluate(body, eval, Map.put(env, parameter, item)) do
          {:bool, value} -> value
          _other -> fail("#{operator} predicate did not evaluate to boolean")
        end
      end)

    {:bool, if(operator == "forall", do: Enum.all?(results), else: Enum.any?(results))}
  end

  defp evaluate_quantifier(operator, _arguments, _eval, _env),
    do: fail("#{operator} requires a collection and one lambda")

  defp evaluate_filter([collection, lambda], eval, env) do
    {kind, items} =
      case evaluate(collection, eval, env) do
        {kind, items} when kind in [:list, :set] -> {kind, items}
        _other -> fail("filter input is not a list or set")
      end

    filtered =
      Enum.filter(items, fn item ->
        case evaluate_lambda(lambda, [item], eval, env) do
          {:bool, value} -> value
          _other -> fail("filter predicate did not evaluate to boolean")
        end
      end)

    {kind, filtered}
  end

  defp evaluate_filter(_arguments, _eval, _env), do: fail("filter requires a list and one lambda")

  defp evaluate_map(operator, [collection, lambda], eval, env) do
    members =
      case evaluate(collection, eval, env) do
        {:set, members} -> members
        _other -> fail("#{operator} input is not a set")
      end

    case operator do
      "map" -> Value.set(Enum.map(members, &evaluate_lambda(lambda, [&1], eval, env)))
      "mapBy" -> Value.map(Enum.map(members, &{&1, evaluate_lambda(lambda, [&1], eval, env)}))
    end
  end

  defp evaluate_map(operator, _arguments, _eval, _env), do: fail("#{operator} requires a set and one lambda")

  defp evaluate_fold([collection, initial, lambda], eval, env) do
    members =
      case evaluate(collection, eval, env) do
        {:set, members} -> members
        _other -> fail("fold input is not a set")
      end

    Enum.reduce(members, evaluate(initial, eval, env), fn member, accumulator ->
      evaluate_lambda(lambda, [accumulator, member], eval, env)
    end)
  end

  defp evaluate_fold(_arguments, _eval, _env), do: fail("fold requires a set, initial value, and lambda")

  defp evaluate_lambda(lambda, arguments, eval, env) do
    if not lambda?(lambda), do: fail("expected a normalized lambda")
    parameters = Json.field(lambda, "parameters")
    if not is_list(parameters), do: fail("normalized lambda has no parameters")

    if length(parameters) != length(arguments) do
      fail("lambda expects #{length(parameters)} arguments, received #{length(arguments)}")
    end

    nested =
      parameters
      |> Enum.zip(arguments)
      |> Enum.reduce(env, fn
        {parameter, argument}, nested when is_binary(parameter) -> Map.put(nested, parameter, argument)
        _other, _nested -> fail("normalized lambda parameter is not a name")
      end)

    evaluate(Json.field(lambda, "body"), eval, nested)
  end

  defp evaluate_match_variant([], _eval, _env), do: fail("matchVariant has no value")

  defp evaluate_match_variant([subject | branches], eval, env) do
    {tag, payload} =
      case evaluate(subject, eval, env) do
        :absent -> {"Absent", nil}
        {:present, value} -> {"Present", value}
        {:variant, tag, value} -> {tag, value}
        {:text, tag} -> {tag, {:tuple, []}}
        _other -> fail("matchVariant value is not a normalized variant")
      end

    match_branch(Enum.chunk_every(branches, 2, 2, :discard), tag, payload, eval, env)
  end

  defp match_branch([], _tag, _payload, _eval, _env), do: fail("matchVariant has no matching branch")

  defp match_branch([[branch_tag, lambda] | rest], tag, payload, eval, env) do
    case evaluate(branch_tag, eval, env) do
      # `_` is Quint's default branch: it matches whatever no earlier branch did.
      {:text, name} when name == tag or name == "_" ->
        if not lambda?(lambda), do: fail("matchVariant branch is not a lambda")
        parameter = first_parameter(lambda) || fail("matchVariant lambda has no parameter")
        branch_env = if payload == nil, do: env, else: Map.put(env, parameter, payload)
        evaluate(Json.field(lambda, "body"), eval, branch_env)

      {:text, _other} ->
        match_branch(rest, tag, payload, eval, env)

      _other ->
        fail("matchVariant tag is not text")
    end
  end
end
