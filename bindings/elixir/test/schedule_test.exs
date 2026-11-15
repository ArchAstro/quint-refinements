defmodule QuintRefinements.ScheduleTest do
  use ExUnit.Case, async: true

  import QuintRefinements.TestSupport, only: [message: 1, minimal_artifact: 0, no_state: 0]

  alias QuintRefinements.{Artifact, Drive, Ownership, Schedule, Value}

  defp descriptor(primitive, refines, aliases \\ []) do
    %{
      owner: "test",
      primitive: primitive,
      refines: refines,
      aliases: aliases,
      actions: refines ++ aliases,
      observations: [],
      retrieve: []
    }
  end

  @steps ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"]

  test "consecutive owned actions schedule one compound tape" do
    assert Schedule.primitive_runs(@steps, [descriptor("gateway.delivery.enqueue", @steps)]) == [
             %{primitive: "gateway.delivery.enqueue", owned_actions: @steps}
           ]
  end

  test "alias actions schedule one evidence each" do
    ownership = [
      descriptor("gateway.connection.register", ["openConnection"], ["openConnectionForRuntimeOwner"]),
      descriptor("gateway.connection.receive_hello", ["receiveHello"])
    ]

    runs = Schedule.primitive_runs(["openConnection", "receiveHello", "openConnectionForRuntimeOwner"], ownership)
    assert length(runs) == 3

    assert List.last(runs) == %{
             primitive: "gateway.connection.register",
             owned_actions: ["openConnectionForRuntimeOwner"]
           }
  end

  test "scheduling fails closed" do
    compound = descriptor("p", ["a", "b", "c"])

    cases = [
      {["a", "b"], [compound], "primitive p JSON actions [a, b] are not the owned sequence [a, b, c]"},
      {["z"], [compound], "JSON action z has no ownership record"},
      {["x"], [descriptor("p1", ["x"]), descriptor("p2", ["x"])],
       "JSON action x is owned by multiple primitives (p1, p2)"}
    ]

    for {actions, ownership, want} <- cases do
      assert message(fn -> Schedule.primitive_runs(actions, ownership) end) == want
    end
  end

  test "legacy action lists are independent one-step runs" do
    legacy = %{descriptor("p", []) | actions: ["a", "b"]}
    assert length(Schedule.primitive_runs(["a", "b"], [legacy])) == 2
  end

  test "ownership aggregation validates and sorts" do
    assert message(fn -> Ownership.collect(%{owner: "o", descriptors: [%{primitive: "  "}]}) end) ==
             "ownership record owned by o has an empty primitive ID"

    assert message(fn ->
             Ownership.collect(%{owner: "o", descriptors: [%{primitive: "p", refines: ["a", "b"], aliases: ["x"]}]})
           end) == "primitive p refines a sequence and cannot declare aliases"

    assert message(fn ->
             Ownership.collect([
               %{owner: "o", descriptors: [%{primitive: "p"}]},
               %{owner: "q", descriptors: [%{primitive: "p"}]}
             ])
           end) == "primitive ID p is declared more than once"

    assert [first, second] =
             Ownership.collect(%{
               owner: "o",
               descriptors: [%{primitive: "b", refines: ["x"], aliases: ["y"], actions: ["x", "z"]}, %{primitive: "a"}]
             })

    assert first.primitive == "a"
    assert second.actions == ["x", "y", "z"], "coverage names are de-duplicated"
  end

  test "an empty primitive id is judged by Unicode White_Space, as Rust's trim does" do
    assert message(fn -> Ownership.collect(%{owner: "o", descriptors: [%{primitive: "\u0085"}]}) end) =~
             "empty primitive ID"

    assert length(Ownership.collect(%{owner: "o", descriptors: [%{primitive: "﻿"}]})) == 1
  end

  test "a compound tape must return one evidence per owned action" do
    [scenario] = Artifact.parse!(minimal_artifact()).scenarios
    ownership = [descriptor("gateway.delivery.enqueue", @steps)]

    assert message(fn ->
             Schedule.collect_owned_action_snapshots(scenario, no_state(), ownership, fn _, _ -> [no_state()] end)
           end) == "primitive gateway.delivery.enqueue owns 3 actions but returned 1 evidence snapshots"

    snapshots =
      Schedule.collect_owned_action_snapshots(scenario, no_state(), ownership, fn _primitive, owned ->
        Enum.map(owned, fn _ -> no_state() end)
      end)

    assert length(snapshots) == 4
  end

  test "a resolved action renders like Rust's Debug" do
    actions = [%{name: "a", arguments: [Value.int(1)]}, %{name: "b", arguments: []}]

    assert Drive.format_actions(actions) ==
             ~S|[ResolvedAction { name: "a", arguments: [Int(1)] }, ResolvedAction { name: "b", arguments: [] }]|

    assert Drive.format_strings(["a", "b"]) == ~S|["a", "b"]|
  end
end
