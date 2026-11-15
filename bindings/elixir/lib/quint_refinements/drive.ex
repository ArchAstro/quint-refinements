defmodule QuintRefinements.Drive do
  @moduledoc """
  Runs an implementation through a generated scenario and evaluates every
  obligation on the way.

  An Elixir implementation is a value, so each driver function takes the
  implementation and returns the new one beside its evidence. The runners
  thread it through the scenario and hand back the final value.

    * `refine_scenario/7` runs one implementation command per ownership record.
      A generated adapter calls this.
    * `run_refined_actions/6` dispatches one Quint action at a time.
    * `QuintRefinements.Drive.Session` is the same loop, one step per call, for
      a harness that owns its own control flow.
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.{Artifact, Evaluate, Evidence, Fixtures, Ownership, Schedule, Value}

  @typedoc "One generated Quint action with arguments normalized through fixtures."
  @type resolved_action :: %{name: String.t(), arguments: [Value.t()]}

  @typedoc """
  Runs `primitive` once and returns one snapshot per resolved action, in that
  order, with the implementation as the command left it.

  Declare 1-to-N with `refines: [a, b, c]` on the ownership record: the driver
  runs the implementation command once and returns three snapshots.
  """
  @type primitive_driver(implementation) ::
          (primitive :: String.t(), actions :: [resolved_action()], implementation ->
             {[Evidence.t()], implementation})

  @typedoc """
  Runs one Quint action and returns what it observed. The evidence may be a
  sparse observation of the fields that action owns: the runner merges it into
  Quint's assigned state before the next action.
  """
  @type action_driver(implementation) :: (resolved_action(), implementation -> {Evidence.t(), implementation})

  @typedoc "The evidence tape and obligation count produced by a stepwise run."
  @type run :: %{snapshots: [Evidence.t()], evaluated: non_neg_integer()}

  @doc "Renders one action in Rust's `Debug` notation, as divergence messages do."
  @spec format_action(resolved_action()) :: String.t()
  def format_action(%{name: name, arguments: arguments}) do
    "ResolvedAction { name: #{Value.debug_string(name)}, arguments: #{Value.debug_values(arguments)} }"
  end

  @doc "Renders actions in Rust's `Debug` notation."
  @spec format_actions([resolved_action()]) :: String.t()
  def format_actions(actions), do: "[" <> Enum.map_join(actions, ", ", &format_action/1) <> "]"

  @doc ~S|Renders strings in Rust's `Debug` notation: `["a", "b"]`.|
  @spec format_strings([String.t()]) :: String.t()
  def format_strings(values), do: Value.debug_strings(values)

  defp bound_retrieve(retrieve, fixtures), do: retrieve ++ Fixtures.retrieve_names(fixtures)
  defp bind_all(snapshots, fixtures), do: Enum.map(snapshots, &Fixtures.bind_evidence(fixtures, &1))

  # Adds the reduced state to argument evaluation.
  defp argument_evidence(state, bound) do
    Evidence.new(
      fn
        "state" -> state
        name -> Evidence.resolve_name(bound, name)
      end,
      fn operator, arguments -> Evidence.resolve_call(bound, operator, arguments) end
    )
  end

  defp resolve_action(step, evidence), do: %{name: step.action, arguments: Evaluate.action_arguments(step, evidence)}

  @doc """
  Resolves the generated action stream against the hydrated initial fixture.

  Drivers use this when a real boundary needs deterministic configuration from
  the scenario (for example, connection IDs) before dispatch begins.
  """
  @spec resolve_action_plan(Artifact.scenario(), Evidence.t(), Fixtures.t()) :: [resolved_action()]
  def resolve_action_plan(scenario, init, fixtures) do
    bound = Fixtures.bind_evidence(fixtures, init)
    scenario |> Artifact.action_steps() |> Enum.map(&resolve_action(&1, bound))
  end

  @doc false
  def projected_state_after(%{initial_state: nil}, snapshots, _retrieve, _fixtures, _action_count) do
    Evidence.resolve_name(List.last(snapshots), "state") || fail("unknown evidence name state")
  end

  def projected_state_after(scenario, snapshots, retrieve, fixtures, action_count) do
    Evaluate.projected_prefix_state(
      scenario,
      bind_all(snapshots, fixtures),
      bound_retrieve(retrieve, fixtures),
      action_count
    )
  end

  @doc false
  def run_pre_guards(%{initial_state: nil}, _action_offset, _state, _snapshot, _retrieve, _fixtures), do: :ok

  def run_pre_guards(scenario, action_offset, state, snapshot, retrieve, fixtures) do
    bound = Fixtures.bind_evidence(fixtures, snapshot)
    Evaluate.projected_pre_guards(scenario, action_offset, state, bound, bound_retrieve(retrieve, fixtures))
    :ok
  end

  @doc false
  def dispatch_evidence(state, snapshot, fixtures),
    do: argument_evidence(state, Fixtures.bind_evidence(fixtures, snapshot))

  @doc false
  def record_step(scenario, step, state, before, after_, retrieve, fixtures) do
    Evaluate.projected_action_step(
      Artifact.scenario_id(scenario),
      step.action,
      step.guards,
      step.next,
      state,
      Fixtures.bind_evidence(fixtures, before),
      Fixtures.bind_evidence(fixtures, after_),
      bound_retrieve(retrieve, fixtures)
    )
  end

  @doc """
  Hydrates a fixture from Quint and dispatches the generated scenario one action
  at a time.

  Each action's pre-guards and arguments use the accumulated state from the
  preceding prefix. The action returns only its observed subset; Quint's
  assignment supplies the rest of the next state. Post-guards and `next` are
  evaluated before the following action is allowed to run.

  Returns the run and the implementation as the last action left it.
  """
  @spec run_refined_actions(
          Artifact.scenario(),
          Evidence.t(),
          [String.t()],
          Fixtures.t(),
          action_driver(implementation),
          implementation
        ) :: {run(), implementation}
        when implementation: var
  def run_refined_actions(scenario, init, retrieve, fixtures, driver, implementation) when is_function(driver, 2) do
    run_session(__MODULE__.Session.new(scenario, init, retrieve, fixtures), driver, implementation)
  end

  defp run_session(session, driver, implementation) do
    case __MODULE__.Session.next_action(session) do
      :done ->
        {__MODULE__.Session.finish(session), implementation}

      {action, session} ->
        {evidence, implementation} = driver.(action, implementation)
        run_session(__MODULE__.Session.record(session, evidence), driver, implementation)
    end
  end

  @doc """
  Walks the generated scenario through ownership records, runs each primitive
  once, and evaluates every guard and next conjunct on the resulting tape.

  `fixtures` owns Quint names (`Idle`, `attemptA`, universe sets). Snapshots
  own live `state`. Model-scope conjuncts are not skipped.

  Returns the number of obligations evaluated and the implementation as the
  last primitive left it. Raises a `QuintRefinements.Error` naming the first
  divergence.
  """
  @spec refine_scenario(
          Artifact.scenario(),
          Evidence.t(),
          [Ownership.descriptor()],
          [String.t()],
          Fixtures.t(),
          primitive_driver(implementation),
          implementation
        ) :: {pos_integer(), implementation}
        when implementation: var
  def refine_scenario(scenario, init, ownership, retrieve, fixtures, driver, implementation)
      when is_function(driver, 3) do
    runs = scenario |> Schedule.scenario_action_names() |> Schedule.primitive_runs(ownership)
    steps = Artifact.action_steps(scenario)
    snapshots = [init]
    state = projected_state_after(scenario, snapshots, retrieve, fixtures, 0)

    {snapshots, _state, _offset, implementation} =
      Enum.reduce(runs, {snapshots, state, 0, implementation}, fn run, {snapshots, state, offset, implementation} ->
        snapshot = List.last(snapshots)
        # Pre-guards are checked, and arguments resolved, before the command runs.
        run_pre_guards(scenario, offset, state, snapshot, retrieve, fixtures)
        evidence = dispatch_evidence(state, snapshot, fixtures)

        actions =
          run.owned_actions
          |> Enum.with_index(offset)
          |> Enum.map(fn {expected, index} ->
            case Enum.at(steps, index) do
              nil ->
                fail("primitive #{run.primitive} has no generated action step")

              %{action: ^expected} = step ->
                resolve_action(step, evidence)

              step ->
                fail("primitive #{run.primitive} expected generated action #{expected} but found #{step.action}")
            end
          end)

        {tape, implementation} = driver.(run.primitive, actions, implementation)
        snapshots = Schedule.extend_validated_tape(snapshots, run, tape)
        offset = offset + length(run.owned_actions)
        state = projected_state_after(scenario, snapshots, retrieve, fixtures, offset)
        {snapshots, state, offset, implementation}
      end)

    {evaluate_refined_tape(scenario, snapshots, retrieve, fixtures), implementation}
  end

  @doc """
  Binds fixtures in front of an already-collected snapshot tape and evaluates
  every guard and next conjunct.
  """
  @spec evaluate_refined_tape(Artifact.scenario(), [Evidence.t()], [String.t()], Fixtures.t()) :: non_neg_integer()
  def evaluate_refined_tape(scenario, snapshots, retrieve, fixtures) do
    bound = bind_all(snapshots, fixtures)
    supported = bound_retrieve(retrieve, fixtures)

    if scenario.initial_state != nil do
      Evaluate.projected_action_steps(scenario, bound, supported)
    else
      Evaluate.all_action_steps(scenario, bound, supported)
    end
  end

  @doc """
  Binds fixtures and evaluates final observations against the state accumulated
  by `evaluate_refined_tape/4`'s Quint-owned reducer.
  """
  @spec evaluate_refined_runtime_assertions(Artifact.scenario(), [Evidence.t()], [String.t()], Fixtures.t(), [
          String.t()
        ]) :: pos_integer()
  def evaluate_refined_runtime_assertions(scenario, snapshots, retrieve, fixtures, supported_dependencies) do
    Evaluate.projected_runtime_assertions(
      scenario,
      bind_all(snapshots, fixtures),
      bound_retrieve(retrieve, fixtures),
      supported_dependencies
    )
  end
end

defmodule QuintRefinements.Drive.Session do
  @moduledoc """
  A step-by-step reducer for runners whose live resources stay in a local
  harness.

  `next_action/1` validates pre-guards and resolves arguments. `record/2`
  merges the sparse observation and validates the post-state before another
  generated action can be requested.

      session = Session.new(scenario, init, retrieve, fixtures)
      {action, session} = Session.next_action(session)
      session = Session.record(session, evidence_after(action))
      :done = Session.next_action(session)
      %{evaluated: evaluated} = Session.finish(session)
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.{Artifact, Drive, Evidence, Fixtures, Value}

  @enforce_keys [:scenario, :retrieve, :fixtures, :steps, :snapshots, :state]
  defstruct [:scenario, :retrieve, :fixtures, :steps, :snapshots, :state, next_index: 0, evaluated: 0, awaiting?: false]

  @opaque t :: %__MODULE__{
            scenario: Artifact.scenario(),
            retrieve: [String.t()],
            fixtures: Fixtures.t(),
            steps: [Artifact.action_step()],
            snapshots: [Evidence.t()],
            state: Value.t(),
            next_index: non_neg_integer(),
            evaluated: non_neg_integer(),
            awaiting?: boolean()
          }

  @doc "Starts a session from generated initial state and runtime evidence."
  @spec new(Artifact.scenario(), Evidence.t(), [String.t()], Fixtures.t()) :: t()
  def new(scenario, init, retrieve, fixtures) do
    %__MODULE__{
      scenario: scenario,
      retrieve: retrieve,
      fixtures: fixtures,
      steps: Artifact.action_steps(scenario),
      snapshots: [init],
      state: Drive.projected_state_after(scenario, [init], retrieve, fixtures, 0)
    }
  end

  @doc """
  Validates the current prefix and resolves the next action for dispatch. It
  returns `:done` when every generated action has been recorded.
  """
  @spec next_action(t()) :: {Drive.resolved_action(), t()} | :done
  def next_action(%__MODULE__{awaiting?: true}) do
    fail("record the preceding Rust action observation before requesting another action")
  end

  def next_action(%__MODULE__{} = session) do
    case Enum.at(session.steps, session.next_index) do
      nil ->
        :done

      step ->
        snapshot = List.last(session.snapshots)

        Drive.run_pre_guards(
          session.scenario,
          session.next_index,
          session.state,
          snapshot,
          session.retrieve,
          session.fixtures
        )

        evidence = Drive.dispatch_evidence(session.state, snapshot, session.fixtures)
        action = %{name: step.action, arguments: QuintRefinements.Evaluate.action_arguments(step, evidence)}
        {action, %{session | awaiting?: true}}
    end
  end

  @doc "Records sparse implementation evidence and reduces the generated next state."
  @spec record(t(), Evidence.t()) :: t()
  def record(%__MODULE__{awaiting?: false}, _evidence) do
    fail("cannot record Rust evidence without a dispatched generated action")
  end

  def record(%__MODULE__{} = session, %Evidence{} = evidence) do
    step = Enum.at(session.steps, session.next_index)
    before = List.last(session.snapshots)

    {evaluated, state} =
      Drive.record_step(session.scenario, step, session.state, before, evidence, session.retrieve, session.fixtures)

    %{
      session
      | snapshots: session.snapshots ++ [evidence],
        evaluated: session.evaluated + evaluated,
        state: state,
        next_index: session.next_index + 1,
        awaiting?: false
    }
  end

  @doc "Completes the session after every generated action has been recorded."
  @spec finish(t()) :: Drive.run()
  def finish(%__MODULE__{awaiting?: true}), do: fail("generated action was dispatched without a Rust observation")

  def finish(%__MODULE__{} = session) do
    if session.next_index != length(session.steps) do
      fail(
        "#{Artifact.scenario_id(session.scenario)} stopped after #{session.next_index} of " <>
          "#{length(session.steps)} generated actions"
      )
    end

    %{snapshots: session.snapshots, evaluated: session.evaluated}
  end
end
