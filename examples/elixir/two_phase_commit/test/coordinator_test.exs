defmodule CoordinatorTest do
  use ExUnit.Case, async: true

  alias QuintRefinements.{Artifact, Drive, Fixtures, Ownership, Value}
  alias TwoPhaseCommit.GeneratedRefinement

  @options [fixtures: &Coordinator.fixtures/1]
  @cases Path.expand("../../../../conformance/cases", __DIR__)

  defp case_file(file), do: File.read!(Path.join([@cases, "two_phase_commit", file]))

  test "commitRun refines the model with one commit/2 owning three actions" do
    results = GeneratedRefinement.refine_all(Coordinator, @options)

    assert Enum.map(results, &{&1.scenario, &1.evaluated_obligations}) == [
             {"two_phase_commit.commitRun", 14},
             {"two_phase_commit.abortBeforePrepareRun", 5}
           ]

    assert hd(results).implementation == %Coordinator{
             status: :Committed,
             wal: ["prepare", "commit"],
             flushed: true
           }
  end

  test "the model's own constants are used when no fixtures are supplied" do
    assert hd(GeneratedRefinement.refine_all(Coordinator)).evaluated_obligations == 14
  end

  test "the two_phase_commit case matches the shared expectation" do
    # Setup: the corpus artifact and expectation, exactly as other bindings read them.
    artifact = Artifact.parse!(case_file("artifact.json"))
    expected = :json.decode(case_file("expected.json"))
    scenario = Enum.find(artifact.scenarios, &(Artifact.scenario_id(&1) == expected["scenario"]))
    fixtures = Coordinator.fixtures()
    Fixtures.validate!(fixtures, artifact)
    coordinator = Coordinator.from_initial_state(Value.from_itf(scenario.initial_state))

    # Notes each primitive call on its way to the generated dispatcher.
    recording = fn primitive, actions, {coordinator, calls} ->
      call = %{
        "primitive" => primitive,
        "actions" => Enum.map(actions, & &1.name),
        "arguments" =>
          Enum.flat_map(actions, fn action -> Enum.map(action.arguments, &elem(&1, 1)) end)
      }

      {tape, coordinator} =
        GeneratedRefinement.run_primitive(Coordinator, primitive, actions, coordinator)

      {tape, {coordinator, calls ++ [call]}}
    end

    # Action: refine the scenario against the real implementation.
    {evaluated, {coordinator, calls}} =
      Drive.refine_scenario(
        scenario,
        Coordinator.snapshot(coordinator),
        Ownership.collect(GeneratedRefinement.ownership()),
        GeneratedRefinement.retrieve(),
        fixtures,
        recording,
        {coordinator, []}
      )

    # Outcome: calls, obligations, and final state all match the shared case.
    assert calls == expected["primitiveCalls"]
    assert evaluated == expected["evaluatedObligations"]

    assert %{
             "status" => Atom.to_string(coordinator.status),
             "flushed" => coordinator.flushed,
             "wal" => coordinator.wal
           } == expected["finalState"]
  end

  defmodule EarlyCommit do
    @moduledoc "Commits without ever flushing the WAL: durability is lost."
    @behaviour TwoPhaseCommit.GeneratedRefinement.Implementation
    defdelegate from_initial_state(initial), to: Coordinator
    defdelegate snapshot(coordinator), to: Coordinator
    defdelegate begin(coordinator, arguments), to: Coordinator
    defdelegate abort(coordinator, arguments), to: Coordinator

    def commit(coordinator, _actions) do
      committed = %{
        coordinator
        | status: :Committed,
          wal: coordinator.wal ++ ["prepare", "commit"]
      }

      done = Coordinator.snapshot(committed)
      {committed, [done, done, done]}
    end
  end

  test "a commit that skips the flush is reported as a divergence" do
    error =
      assert_raise QuintRefinements.Error, fn ->
        GeneratedRefinement.refine_all(EarlyCommit, @options)
      end

    assert error.message ==
             "two_phase_commit.commitRun:prepare next: assign state diverged at state.status " <>
               ~s|expected Text("Prepared"), observed Text("Committed")|
  end

  test "a status the production type does not know fails the fixture check" do
    drifted = fn _artifact ->
      idle = {%{"tag" => "Idle", "value" => %{"#tup" => []}}, Value.text("Idle")}
      Fixtures.insert_set(Coordinator.fixtures(), "statuses", [idle])
    end

    assert_raise QuintRefinements.Error, ~r/fixture statuses JSON diverged/, fn ->
      GeneratedRefinement.refine_all(Coordinator, fixtures: drifted)
    end
  end
end
