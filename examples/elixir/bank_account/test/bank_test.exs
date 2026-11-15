defmodule BankTest do
  use ExUnit.Case, async: true

  alias Bank.GeneratedRefinement
  alias QuintRefinements.{Artifact, Drive, Fixtures, Ownership, Value}

  @cases Path.expand("../../../../conformance/cases", __DIR__)

  defp case_file(name, file), do: File.read!(Path.join([@cases, name, file]))
  defp expected(name), do: name |> case_file("expected.json") |> :json.decode()

  # Runs one shared corpus case the way every binding does: the corpus artifact,
  # the generated ownership table and the real bank, recording each primitive
  # call on its way to the generated dispatcher.
  defp run_case(name) do
    artifact = Artifact.parse!(case_file(name, "artifact.json"))
    expected = expected(name)
    scenario = Enum.find(artifact.scenarios, &(Artifact.scenario_id(&1) == expected["scenario"]))
    fixtures = Fixtures.from_artifact("bank", artifact)
    Fixtures.validate!(fixtures, artifact)
    bank = Bank.Adapter.from_initial_state(Value.from_itf(scenario.initial_state))

    recording = fn primitive, actions, {bank, calls} ->
      call = %{
        "primitive" => primitive,
        "actions" => Enum.map(actions, & &1.name),
        "arguments" =>
          Enum.flat_map(actions, fn action -> Enum.map(action.arguments, &elem(&1, 1)) end)
      }

      {tape, bank} = GeneratedRefinement.run_primitive(Bank.Adapter, primitive, actions, bank)
      {tape, {bank, calls ++ [call]}}
    end

    {evaluated, {bank, calls}} =
      Drive.refine_scenario(
        scenario,
        Bank.Adapter.snapshot(bank),
        Ownership.collect(GeneratedRefinement.ownership()),
        GeneratedRefinement.retrieve(),
        fixtures,
        recording,
        {bank, []}
      )

    %{expected: expected, calls: calls, evaluated: evaluated, bank: bank}
  end

  test "generated Quint withdrawal drives the real bank and checks its snapshot" do
    # Setup: the compile step generated the scenario and the Elixir adapter.
    # Boundary: generated ownership passes withdraw(4) to the real Bank.
    expected = expected("bank_withdraw")
    assert [result] = GeneratedRefinement.refine_all(Bank.Adapter)

    # Outcome: all guards and the assignment match the shared binding corpus.
    assert result.scenario == expected["scenario"]
    assert result.evaluated_obligations == expected["evaluatedObligations"]
    assert result.implementation.balance == expected["finalState"]["balance"]
  end

  for name <- ["bank_withdraw", "bank_withdraw_v2"] do
    test "the #{name} case matches the shared expectation" do
      %{expected: expected, calls: calls, evaluated: evaluated, bank: bank} =
        run_case(unquote(name))

      assert calls == expected["primitiveCalls"]
      assert evaluated == expected["evaluatedObligations"]
      assert %{"balance" => bank.balance} == expected["finalState"]
    end
  end

  defmodule DepositingBank do
    @moduledoc "Adds to the balance instead of taking from it."
    @behaviour Bank.GeneratedRefinement.Implementation
    defdelegate from_initial_state(initial), to: Bank.Adapter
    defdelegate snapshot(bank), to: Bank.Adapter
    def withdraw(bank, _arguments), do: %{bank | balance: bank.balance + 4}
  end

  defmodule ForgetfulBank do
    @moduledoc "Forgets to take the money out."
    @behaviour Bank.GeneratedRefinement.Implementation
    defdelegate from_initial_state(initial), to: Bank.Adapter
    defdelegate snapshot(bank), to: Bank.Adapter
    def withdraw(bank, _arguments), do: bank
  end

  defmodule BrokeBank do
    @moduledoc "Starts with less money than the model says."
    @behaviour Bank.GeneratedRefinement.Implementation
    def from_initial_state(_initial), do: %Bank{balance: 1}
    defdelegate snapshot(bank), to: Bank.Adapter
    defdelegate withdraw(bank, arguments), to: Bank.Adapter
  end

  test "a bank that deposits instead of withdrawing is reported as a divergence" do
    error =
      assert_raise QuintRefinements.Error, fn ->
        GeneratedRefinement.refine_all(DepositingBank)
      end

    assert error.message ==
             "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)"
  end

  test "a bank that ignores withdrawals is reported as a divergence" do
    error =
      assert_raise QuintRefinements.Error, fn -> GeneratedRefinement.refine_all(ForgetfulBank) end

    assert error.message ==
             "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(10)"
  end

  test "a bank whose starting balance disagrees with the model is rejected before any action" do
    # The model starts with 10; the snapshot taken before the first action
    # already disagrees with it.
    error =
      assert_raise QuintRefinements.Error, fn -> GeneratedRefinement.refine_all(BrokeBank) end

    assert error.message =~
             "Rust fixture does not match Quint initial state: state.balance expected Int(10), observed Int(1)"
  end
end
