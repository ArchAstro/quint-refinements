defmodule QuintRefinements.DriveTest do
  use ExUnit.Case, async: true

  import QuintRefinements.TestSupport,
    only: [assertion: 1, call: 2, corpus: 2, int_expr: 1, message: 1, name_expr: 1, text_expr: 1]

  alias QuintRefinements.{Artifact, Drive, Evaluate, Evidence, Fixtures, Ownership, Value}
  alias QuintRefinements.Drive.Session

  # The bank model: balance 10, then withdraw(4), then assert balance == 6.
  @retrieve [
    "name:state",
    "operator:Rec",
    "operator:assign",
    "operator:eq",
    "operator:field",
    "operator:igt",
    "operator:igte",
    "operator:isub",
    "path:state.balance"
  ]

  setup_all do
    artifact = Artifact.parse!(corpus("bank_withdraw", "artifact.json"))

    %{
      scenario: hd(artifact.scenarios),
      fixtures: Fixtures.from_artifact("bank", artifact),
      ownership:
        Ownership.collect(%{owner: "test", descriptors: [%{primitive: "bank.withdraw", refines: ["withdraw"]}]})
    }
  end

  defp bank(balance), do: Evidence.state(Value.record(balance: Value.int(balance)))
  defp withdraw_to(balance), do: fn _primitive, _actions, calls -> {[bank(balance)], calls} end

  defp refine(context, init, driver, implementation \\ nil) do
    Drive.refine_scenario(
      context.scenario,
      init,
      context.ownership,
      @retrieve,
      context.fixtures,
      driver,
      implementation
    )
  end

  test "refine_scenario walks the scenario through a primitive driver and counts obligations", context do
    driver = fn primitive, actions, calls -> {[bank(6)], calls ++ [{primitive, actions}]} end

    assert refine(context, bank(10), driver, []) ==
             {3, [{"bank.withdraw", [%{name: "withdraw", arguments: [Value.int(4)]}]}]}

    assert QuintRefinements.refine_scenario(
             context.scenario,
             bank(10),
             context.ownership,
             @retrieve,
             context.fixtures,
             withdraw_to(6),
             :implementation
           ) == {3, :implementation}
  end

  test "refine_scenario reports the first divergence with the Rust and Go message", context do
    assert message(fn -> refine(context, bank(10), withdraw_to(14)) end) ==
             "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)"
  end

  test "a driver that returns the wrong number of snapshots is rejected", context do
    assert message(fn -> refine(context, bank(10), fn _, _, calls -> {[], calls} end) end) ==
             "primitive bank.withdraw owns 1 actions but returned 0 evidence snapshots"
  end

  test "a scheduling failure surfaces before any primitive runs", context do
    driver = fn _, _, _ -> flunk("must not run") end

    assert message(fn ->
             Drive.refine_scenario(context.scenario, bank(10), [], @retrieve, context.fixtures, driver, nil)
           end) == "JSON action withdraw has no ownership record"
  end

  test "a failed pre-guard stops the scenario before its command runs", context do
    # A guard that does not assign state is checked against the state before
    # the action, so a false one must not reach the implementation.
    [init, action | rest] = context.scenario.steps
    never = assertion(call("eq", [int_expr(1), int_expr(2)]))
    scenario = %{context.scenario | steps: [init, %{action | guards: [never | action.guards]} | rest]}
    driver = fn _, _, _ -> flunk("must not run") end

    assert message(fn ->
             Drive.refine_scenario(scenario, bank(10), context.ownership, @retrieve, context.fixtures, driver, nil)
           end) =~ "pre-guard assertion evaluated false in bank.withdrawRun:withdraw"
  end

  test "an initial snapshot that disagrees with the model's initial state is rejected", context do
    assert message(fn -> refine(context, bank(3), withdraw_to(6)) end) ==
             "bank.withdrawRun Rust fixture does not match Quint initial state: " <>
               "state.balance expected Int(10), observed Int(3)"
  end

  test "resolve_action_plan evaluates every action's arguments up front", context do
    assert Drive.resolve_action_plan(context.scenario, bank(10), context.fixtures) == [
             %{name: "withdraw", arguments: [Value.int(4)]}
           ]
  end

  test "run_refined_actions merges sparse observations into the model's next state", context do
    run = fn driver -> Drive.run_refined_actions(context.scenario, bank(10), @retrieve, context.fixtures, driver, 0) end
    assert {%{evaluated: 3, snapshots: [_, _]}, 1} = run.(fn _action, count -> {bank(6), count + 1} end)

    # An observation that omits a runtime-owned field the action changed is rejected.
    assert message(fn -> run.(fn _action, count -> {Evidence.state(Value.record()), count} end) end) ==
             "bank.withdrawRun:withdraw state evidence: Rust action omitted changed runtime-owned field state.balance"

    assert message(fn -> run.(fn _action, count -> {bank(14), count} end) end) ==
             "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)"
  end

  test "a session enforces dispatch, record, dispatch, record", context do
    session = Session.new(context.scenario, bank(10), @retrieve, context.fixtures)

    assert message(fn -> Session.record(session, bank(6)) end) ==
             "cannot record Rust evidence without a dispatched generated action"

    assert message(fn -> Session.finish(session) end) =~ "stopped after 0 of 1 generated actions"
    assert {action, dispatched} = Session.next_action(session)
    assert action == %{name: "withdraw", arguments: [Value.int(4)]}

    assert message(fn -> Session.next_action(dispatched) end) ==
             "record the preceding Rust action observation before requesting another action"

    assert message(fn -> Session.finish(dispatched) end) == "generated action was dispatched without a Rust observation"
    recorded = Session.record(dispatched, bank(6))
    assert Session.next_action(recorded) == :done
    assert Session.finish(recorded).evaluated == 3
  end

  test "a collected tape evaluates to the same count, with and without the model's initial state", context do
    tape = [bank(10), bank(6)]
    assert Drive.evaluate_refined_tape(context.scenario, tape, @retrieve, context.fixtures) == 3
    # Without a generated initial state every guard and next conjunct is
    # checked directly against the snapshots.
    partial = %{context.scenario | initial_state: nil}
    assert Drive.evaluate_refined_tape(partial, tape, @retrieve, context.fixtures) == 3
    assert Evaluate.every_action_step(partial, tape, @retrieve) == 3

    assert message(fn -> Drive.evaluate_refined_tape(partial, [bank(10)], @retrieve, context.fixtures) end) ==
             "bank.withdrawRun has 1 actions but 1 snapshots (want init plus one after each action)"

    assert message(fn -> Evaluate.projected_action_steps(partial, tape, @retrieve) end) ==
             "bank.withdrawRun has no complete initial state"

    assert {3, nil} =
             Drive.refine_scenario(
               partial,
               bank(10),
               context.ownership,
               @retrieve,
               context.fixtures,
               withdraw_to(6),
               nil
             )
  end

  test "final observations are checked against the reduced state", context do
    balance = call("field", [name_expr("state"), text_expr("balance")])
    observe = %{kind: :observe, index: 2, assertions: [assertion(call("eq", [balance, int_expr(6)]))]}
    scenario = %{context.scenario | steps: Enum.reject(context.scenario.steps, &(&1.kind == :observe)) ++ [observe]}
    tape = [bank(10), bank(6)]

    assert Drive.evaluate_refined_runtime_assertions(scenario, tape, @retrieve, context.fixtures, ["operator:field"]) ==
             1

    assert Evaluate.runtime_assertions(scenario, bank(6), ["operator:field"]) == 1
    # An action without next-state obligations contributes nothing to its chapter.
    quiet = %{scenario | steps: Enum.map(scenario.steps, &if(&1.kind == :action, do: %{&1 | next: []}, else: &1))}
    assert Evaluate.chapter_next(quiet, bank(6), @retrieve) == 0

    assert message(fn -> Evaluate.runtime_assertions(scenario, bank(7), ["operator:field"]) end) =~
             "observe assertion evaluated false in bank.withdrawRun"

    assert message(fn ->
             Drive.evaluate_refined_runtime_assertions(scenario, [bank(10)], @retrieve, context.fixtures, [])
           end) == "bank.withdrawRun has 1 actions but 1 snapshots"

    without = %{scenario | steps: Enum.reject(scenario.steps, &(&1.kind == :observe))}

    assert message(fn -> Evaluate.runtime_assertions(without, bank(6), []) end) ==
             "bank.withdrawRun evaluated no runtime assertions"
  end
end
