defmodule QuintRefinements.FixturesTest do
  use ExUnit.Case, async: true

  import QuintRefinements.TestSupport

  alias QuintRefinements.{Artifact, Evidence, Fixtures, Value}

  defp artifact_with_fixtures(fixtures) do
    minimal_artifact()
    |> String.replace(~S|"fixtures": { "m": {} }|, ~s|"fixtures": { "m": #{fixtures} }|)
    |> Artifact.parse!()
  end

  defp status(tag), do: {%{"tag" => tag, "value" => %{"#tup" => []}}, Value.text(tag)}

  test "a table taken from the artifact has the model's values" do
    artifact = artifact_with_fixtures(~S|{"limit": 3, "roles": {"#set": [{"tag": "A", "value": {"#tup": []}}]}}|)
    table = Fixtures.from_artifact("m", artifact)
    assert Fixtures.get(table, "limit") == Value.int(3)
    assert Value.equal?(Fixtures.get(table, "roles"), Value.set([Value.text("A")]))
    assert Fixtures.validate!(table, artifact) == :ok
    assert Fixtures.retrieve_names(table) == ["name:limit", "name:roles"]
    assert Fixtures.names(Fixtures.from_artifact("absent", artifact)) == []
  end

  test "owned fixtures are checked against the model" do
    artifact =
      artifact_with_fixtures(
        ~S|{"limit": 3, "roles": {"#set": [{"tag": "A", "value": {"#tup": []}}, {"tag": "B", "value": {"#tup": []}}]}}|
      )

    table = fn limit ->
      Fixtures.new("m")
      |> Fixtures.insert("limit", Fixtures.int(limit))
      |> Fixtures.insert_set("roles", [status("B"), status("A")])
    end

    assert Fixtures.validate!(table.(3), artifact) == :ok

    assert message(fn -> Fixtures.validate!(table.(4), artifact) end) ==
             "fixture limit JSON diverged: artifact 3 rust 4"

    missing = Fixtures.insert(Fixtures.new("m"), "limit", Fixtures.int(3))

    assert message(fn -> Fixtures.validate!(missing, artifact) end) ==
             ~S|fixture namespace m names differ: artifact ["limit", "roles"] rust ["limit"]|

    # Entry validation tolerates extra artifact fixtures.
    assert Fixtures.validate_entries!(missing, artifact) == :ok

    assert message(fn -> Fixtures.validate!(Fixtures.new("other"), artifact) end) ==
             "fixture namespace other is missing from the artifact"

    ghost = Fixtures.insert(Fixtures.new("m"), "ghost", Fixtures.int(1))

    assert message(fn -> Fixtures.validate_entries!(ghost, artifact) end) ==
             "artifact namespace m is missing fixture ghost"
  end

  test "fixture JSON may be written with integers of any size or nested maps" do
    artifact = artifact_with_fixtures(~S|{"big": 9007199254740993, "org": {"id": "o1", "tags": ["x"]}}|)

    table =
      Fixtures.new("m")
      |> Fixtures.insert("big", Fixtures.int(9_007_199_254_740_993))
      |> Fixtures.insert("org", {%{id: "o1", tags: ["x"]}, Value.int(0)})

    assert Fixtures.validate!(table, artifact) == :ok
    wrong = Fixtures.insert(Fixtures.new("m"), "big", Fixtures.text("9007199254740993"))
    assert message(fn -> Fixtures.validate_entries!(wrong, artifact) end) =~ "fixture big JSON diverged"
  end

  test "record fixtures differ in key-subset versus exact mode" do
    artifact = artifact_with_fixtures(~S|{"org": {"id": "o1", "name": "Acme"}}|)
    partial = Fixtures.insert(Fixtures.new("m"), "org", {%{"id" => "o1"}, Value.text("")})
    # A key subset matches in entry mode, and is not enough for full validation.
    assert Fixtures.validate_entries!(partial, artifact) == :ok
    assert message(fn -> Fixtures.validate!(partial, artifact) end) =~ "fixture org JSON diverged"
    renamed = Fixtures.insert(Fixtures.new("m"), "org", {%{"organization_id" => "o1"}, Value.text("")})
    assert message(fn -> Fixtures.validate_entries!(renamed, artifact) end) =~ "fixture org JSON diverged"
  end

  test "a false or null fixture is compared like any other" do
    artifact = artifact_with_fixtures(~S|{"flag": true, "parent": 1}|)

    table = fn flag, parent ->
      Fixtures.new("m")
      |> Fixtures.insert("flag", {flag, Value.bool(false)})
      |> Fixtures.insert("parent", {parent, Value.int(1)})
    end

    assert message(fn -> Fixtures.validate!(table.(false, 1), artifact) end) ==
             "fixture flag JSON diverged: artifact true rust false"

    assert message(fn -> Fixtures.validate!(table.(true, nil), artifact) end) ==
             "fixture parent JSON diverged: artifact 1 rust null"
  end

  test "a float fixture is not an integer fixture" do
    artifact = artifact_with_fixtures(~S|{"a": 1.0}|)
    table = Fixtures.insert(Fixtures.new("m"), "a", Fixtures.int(1))
    assert message(fn -> Fixtures.validate!(table, artifact) end) == "fixture a JSON diverged: artifact 1.0 rust 1"
  end

  test "scenario names must have an owner" do
    guard =
      ~S|"guards": [{"scope": "runtime", "expression": {"kind": "call", "operator": "contains", "arguments": [{"kind": "name", "value": "universe"}, {"kind": "name", "value": "state"}]}}]|

    artifact =
      minimal_artifact()
      |> String.replace(
        ~S|"action": "submitInvocation", "arguments": []|,
        ~s|"action": "submitInvocation", "arguments": [], #{guard}|
      )
      |> Artifact.parse!()

    table = Fixtures.new("m")

    assert message(fn -> Fixtures.validate!(table, artifact) end) ==
             "m.run:submitInvocation names universe but neither fixtures nor snapshot state own it"

    # Unselected scenarios are not checked.
    assert Fixtures.validate_selected!(table, artifact, ["m.other"]) == :ok
  end

  test "expression_names honors binders" do
    expression = call("forall", [name_expr("xs"), lambda(call("eq", [name_expr("x"), name_expr("limit")]), ["x"])])
    assert Fixtures.expression_names(expression) == ["xs", "limit"]
    let = %{"kind" => "let", "name" => "y", "value" => name_expr("y"), "body" => name_expr("y")}
    assert Fixtures.expression_names(let) == ["y"], "the let value sees the outer y only"
  end

  test "bound evidence answers fixture names first and falls through to the snapshot" do
    table = Fixtures.insert(Fixtures.new("m"), "limit", Fixtures.int(3))
    calls = fn operator, arguments -> if operator == "twice", do: Value.list(arguments ++ arguments) end
    snapshot = Evidence.new(fn name -> if name in ["state", "limit"], do: Value.int(0) end, calls)
    bound = Fixtures.bind_evidence(table, snapshot)
    assert Evidence.resolve_name(bound, "limit") == Value.int(3)
    assert Evidence.resolve_name(bound, "state") == Value.int(0)
    assert Evidence.resolve_name(bound, "missing") == nil
    assert Evidence.resolve_call(bound, "twice", [Value.int(1)]) == Value.list([Value.int(1), Value.int(1)])
    assert Evidence.resolve_call(bound, "other", []) == nil
    assert Fixtures.contains_name?(table, "limit")
  end
end
