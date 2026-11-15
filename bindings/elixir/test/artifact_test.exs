defmodule QuintRefinements.ArtifactTest do
  use ExUnit.Case, async: true

  import QuintRefinements.TestSupport, only: [corpus: 2, message: 1, minimal_artifact: 0]

  alias QuintRefinements.Artifact

  @eq_one ~S|{"scope":"runtime","expression":{"kind":"call","operator":"eq","arguments":[{"kind":"name","value":"state"},{"kind":"int","value":1}]}}|

  defp edit(from, to) do
    text = String.replace(minimal_artifact(), from, to)
    assert text != minimal_artifact(), "the test edit did not apply: #{from}"
    text
  end

  test "parses the shared corpus artifacts" do
    for name <- ["bank_withdraw", "two_phase_commit"] do
      artifact = Artifact.parse!(corpus(name, "artifact.json"))
      assert artifact.schema_version == 3
      assert artifact.scenarios != [], name
      for scenario <- artifact.scenarios, do: assert(scenario.initial_state != nil, Artifact.scenario_id(scenario))
    end
  end

  test "parses every field of a minimal artifact" do
    artifact = Artifact.parse!(minimal_artifact())
    assert artifact.model_digest == "sha256:test"
    assert artifact.vocabulary.capabilities == ["transport.basic"]
    assert artifact.vocabulary.refinement_expression_operators == []
    assert artifact.fixtures == %{"m" => %{}}
    assert [scenario] = artifact.scenarios
    assert Artifact.scenario_id(scenario) == "m.run"
    assert Enum.map(scenario.steps, & &1.kind) == [:init, :action, :action, :action]
    assert Enum.map(Artifact.action_steps(scenario), & &1.action) == artifact.vocabulary.actions
    assert scenario.initial_state == nil
  end

  test "parse rejects malformed artifacts" do
    cases = [
      {~S|"schemaVersion": 2,|, ~S|"schemaVersion": 2, "extra": 1,|, "unknown field `extra` in artifact"},
      {~S|"modelDigest": "sha256:test",|, "", "missing field `modelDigest`"},
      {~S|"kind": "init", "action": "init"|, ~S|"kind": "init", "action": "init", "guards": []|,
       "unknown field `guards` in step"},
      {~S|"kind": "init"|, ~S|"kind": "teleport"|, "unknown variant `teleport`"},
      {~S|"schemaVersion": 2|, ~S|"schemaVersion": "two"|, "invalid field `schemaVersion`"},
      {~S|"schemaVersion": 2|, ~S|"schemaVersion": 4294967296|, "invalid field `schemaVersion`"},
      {~S|"index": 1,|, ~S|"index": -1,|, "invalid field `index`"},
      {~S|"index": 1,|, ~S|"index": 9007199254740993,|, "invalid field `index`: expected an unsigned integer"},
      {~S|"action": "submitInvocation", "arguments": []|,
       ~S|"action": "submitInvocation", "arguments": [], "guards": [{"scope": "x", "expression": {}}]|,
       "unknown variant `x`"},
      {~S|"capabilities": ["transport.basic"]|, ~S|"capabilities": [1]|, "invalid field `capabilities`"},
      {~S|"fixtures": { "m": {} }|, ~S|"fixtures": { "m": 1 }|,
       "invalid field `fixtures`: expected an object of objects"},
      {~S|"module": "m",|, ~S|"module": "m", "surprise": true,|, "unknown field `surprise` in scenario"}
    ]

    for {from, to, want} <- cases do
      error = message(fn -> Artifact.parse!(edit(from, to)) end)
      assert String.starts_with?(error, "invalid refinement artifact: "), error
      assert error =~ want
    end

    assert message(fn -> Artifact.parse!("[]") end) == "invalid refinement artifact: artifact must be an object"
    assert message(fn -> Artifact.parse!("{") end) =~ "invalid refinement artifact: invalid JSON"
  end

  test "a complete refinement artifact must use the evaluator's vocabulary" do
    text = edit(~S|"steps": [|, ~S|"initialState": {}, "steps": [|)

    assert message(fn -> Artifact.parse!(text) end) ==
             "artifact refinement expression vocabulary differs from the Elixir evaluator"
  end

  defp shared(version, extra, fields) do
    """
    {
      "schemaVersion": #{version},
      "modelDigest": "sha256:shared-assertions-test",
      "vocabulary": {
        "actions": ["step"], "capabilities": [], "expressionOperators": [], "expressionNames": [],
        "runtimeObservationDependencies": [], "runtimeObservationDependencyDigest": "sha256:test"
      },
      "fixtures": {},
      #{extra}
      "scenarios": [{
        "source": "s.qnt", "module": "s", "fixtureNamespace": "s", "name": "run",
        "requiredCapabilities": [],
        "steps": [{"index": 1, "kind": "action", "action": "step", "arguments": [] #{fields}}]
      }]
    }
    """
  end

  defp first_action(source),
    do: source |> Artifact.parse!() |> Map.fetch!(:scenarios) |> hd() |> Map.fetch!(:steps) |> hd()

  test "v3 steps resolve their shared lists" do
    lists = ~s|"assertionLists": [[#{@eq_one}], [#{@eq_one}, #{@eq_one}]],|
    step = first_action(shared(3, lists, ~S|, "guardList": 0, "nextList": 1|))
    assert length(step.guards) == 1
    assert length(step.next) == 2
    assert hd(step.guards).scope == :runtime
  end

  test "v2 inline lists still load" do
    source = shared(2, "", ~s|, "guards": [#{@eq_one}], "next": [#{@eq_one}]|)
    assert Artifact.parse!(source).schema_version == 2
    step = first_action(source)
    assert length(step.guards) == 1
    assert length(step.next) == 1
  end

  test "the v2 and v3 corpus artifacts resolve to the same scenarios" do
    v2 = Artifact.parse!(corpus("bank_withdraw_v2", "artifact.json"))
    v3 = Artifact.parse!(corpus("bank_withdraw", "artifact.json"))
    assert v2.schema_version == 2
    assert v3.schema_version == 3
    assert v2.scenarios == v3.scenarios
  end

  test "bad shared lists are rejected" do
    lists = ~s|"assertionLists": [[#{@eq_one}]],|

    cases = [
      {shared(3, lists, ~S|, "guardList": 1|), "`guardList` 1 is out of range: the artifact has 1 assertion lists"},
      {shared(3, "", ~S|, "nextList": 0|), "`nextList` 0 is out of range"},
      {shared(3, lists, ~S|, "nextList": -1|), "`nextList` -1 is out of range"},
      {shared(3, lists, ~S|, "nextList": "0"|), "`nextList` 0 is out of range"},
      {shared(3, lists, ~s|, "guards": [#{@eq_one}]|), "inline"},
      {shared(2, "", ~S|, "guardList": 0|), "schema version 3"},
      {shared(2, lists, ""), "`assertionLists` needs schema version 3, found 2"},
      {shared(3, ~S|"assertionLists": {},|, ""), "invalid field `assertionLists`: expected an array"},
      {shared(3, ~S|"assertionLists": [1],|, ""), "invalid field `assertionLists`: expected an array of arrays"},
      {shared(4, "", ""), "unsupported schema version 4; this runtime reads versions 2 to 3"}
    ]

    for {source, want} <- cases do
      assert message(fn -> Artifact.parse!(source) end) =~ want
    end
  end
end
