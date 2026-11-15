defmodule QuintRefinements.EvaluateTest do
  use ExUnit.Case, async: true

  import QuintRefinements.TestSupport
  import QuintRefinements.Value

  alias QuintRefinements.{Evaluate, Evidence}

  defp evaluate(expression), do: Evaluate.expression(expression, no_state())

  defp set_of(values), do: call("Set", values)
  defp tup(left, right), do: call("Tup", [left, right])
  defp record12, do: call("Rec", [text_expr("a"), int_expr(1), text_expr("b"), int_expr(2)])
  defp greater_than(limit), do: lambda(call("igt", [name_expr("x"), int_expr(limit)]), ["x"])
  defp out_of_bounds, do: call("nth", [call("List"), int_expr(0)])

  defp operator_cases do
    [
      {"eq", call("eq", [int_expr(1), int_expr(1)]), bool(true)},
      {"neq", call("neq", [int_expr(1), int_expr(1)]), bool(false)},
      {"not", call("not", [bool_expr(false)]), bool(true)},
      {"and", call("and", [bool_expr(true), bool_expr(false)]), bool(false)},
      {"or", call("or", [bool_expr(false), bool_expr(true)]), bool(true)},
      {"actionAll", call("actionAll", [bool_expr(true), bool_expr(true)]), bool(true)},
      {"actionAny", call("actionAny", [bool_expr(false), bool_expr(false)]), bool(false)},
      {"iadd", call("iadd", [int_expr(2), int_expr(3)]), int(5)},
      {"isub", call("isub", [int_expr(2), int_expr(3)]), int(-1)},
      {"ilt", call("ilt", [int_expr(2), int_expr(3)]), bool(true)},
      {"igt", call("igt", [int_expr(2), int_expr(3)]), bool(false)},
      {"ilte", call("ilte", [int_expr(3), int_expr(3)]), bool(true)},
      {"igte", call("igte", [int_expr(2), int_expr(3)]), bool(false)},
      {"iadd past 2^63", call("iadd", [int_expr(9_223_372_036_854_775_807), int_expr(1)]),
       int(9_223_372_036_854_775_808)},
      {"isub past -2^63", call("isub", [int_expr(-9_223_372_036_854_775_808), int_expr(1)]),
       int(-9_223_372_036_854_775_809)},
      {"set dedup", call("size", [set_of([int_expr(1), int_expr(1), int_expr(2)])]), int(2)},
      {"size of list", call("size", [call("List", [int_expr(1)])]), int(1)},
      {"size of tuple", call("size", [tup(int_expr(1), int_expr(2))]), int(2)},
      {"size of map", call("size", [call("Map", [tup(text_expr("k"), int_expr(1))])]), int(1)},
      {"size of record", call("size", [record12()]), int(2)},
      {"contains", call("contains", [set_of([int_expr(1)]), int_expr(1)]), bool(true)},
      {"union", call("union", [set_of([int_expr(1)]), set_of([int_expr(2)])]), set([int(1), int(2)])},
      {"exclude", call("exclude", [set_of([int_expr(1), int_expr(2)]), set_of([int_expr(2)])]), set([int(1)])},
      {"field", call("field", [record12(), text_expr("b")]), int(2)},
      {"get missing field is Absent", call("get", [record12(), text_expr("z")]), absent()},
      {"with", call("field", [call("with", [record12(), text_expr("a"), int_expr(9)]), text_expr("a")]), int(9)},
      {"set on a record", call("field", [call("set", [record12(), text_expr("a"), int_expr(9)]), text_expr("a")]),
       int(9)},
      {"list ops",
       call("concat", [call("append", [call("List", [int_expr(1)]), int_expr(2)]), call("List", [int_expr(3)])]),
       list([int(1), int(2), int(3)])},
      {"length", call("length", [call("List", [int_expr(1), int_expr(2)])]), int(2)},
      {"nth", call("nth", [call("List", [int_expr(7), int_expr(8)]), int_expr(1)]), int(8)},
      {"indices", call("indices", [call("List", [int_expr(7), int_expr(8)])]), set([int(0), int(1)])},
      {"indices of an empty list", call("indices", [call("List")]), set()},
      {"map get", call("get", [call("Map", [tup(text_expr("k"), int_expr(1))]), text_expr("k")]), int(1)},
      {"map put", call("size", [call("put", [call("Map"), text_expr("k"), int_expr(1)])]), int(1)},
      {"map set",
       call("get", [
         call("set", [call("Map", [tup(text_expr("k"), int_expr(1))]), text_expr("k"), int_expr(2)]),
         text_expr("k")
       ]), int(2)},
      {"keys", call("keys", [call("Map", [tup(text_expr("k"), int_expr(1))])]), set([text("k")])},
      {"ite", call("ite", [bool_expr(false), int_expr(1), int_expr(2)]), int(2)},
      {"forall", call("forall", [set_of([int_expr(1), int_expr(2)]), greater_than(0)]), bool(true)},
      {"forall over a list", call("forall", [call("List", [int_expr(1), int_expr(2)]), greater_than(1)]), bool(false)},
      {"exists", call("exists", [set_of([int_expr(1), int_expr(2)]), greater_than(1)]), bool(true)},
      {"exists over map values", call("exists", [call("Map", [tup(text_expr("k"), int_expr(5))]), greater_than(4)]),
       bool(true)},
      {"exists over record values", call("exists", [record12(), greater_than(1)]), bool(true)},
      {"filter list", call("filter", [call("List", [int_expr(1), int_expr(2), int_expr(3)]), greater_than(1)]),
       list([int(2), int(3)])},
      {"filter set", call("filter", [set_of([int_expr(1), int_expr(2)]), greater_than(1)]), set([int(2)])},
      {"map over a set",
       call("map", [set_of([int_expr(1), int_expr(2)]), lambda(call("iadd", [name_expr("x"), int_expr(10)]), ["x"])]),
       set([int(11), int(12)])},
      {"mapBy",
       call("get", [
         call("mapBy", [set_of([int_expr(1)]), lambda(call("iadd", [name_expr("x"), int_expr(1)]), ["x"])]),
         int_expr(1)
       ]), int(2)},
      {"fold",
       call("fold", [
         set_of([int_expr(1), int_expr(2), int_expr(3)]),
         int_expr(0),
         lambda(call("iadd", [name_expr("a"), name_expr("x")]), ["a", "x"])
       ]), int(6)},
      {"let",
       %{
         "kind" => "let",
         "name" => "x",
         "value" => int_expr(4),
         "body" => call("iadd", [name_expr("x"), name_expr("x")])
       }, int(8)},
      {"Present", call("Present", [int_expr(1)]), present(int(1))},
      {"unknown uppercase operator builds a variant", call("Ok", [int_expr(1)]), variant("Ok", int(1))},
      {"the constructor fallback uses Unicode Uppercase", call("Ⓐ", [int_expr(1)]), variant("Ⓐ", int(1))},
      {"variant", call("variant", [text_expr("Tag"), int_expr(1)]), variant("Tag", int(1))},
      {"Absent name defaults", name_expr("Absent"), absent()},
      {"disabled name", name_expr("disabled"), bool(false)},
      {"matchVariant on unit",
       call("matchVariant", [
         text_expr("B"),
         text_expr("A"),
         lambda(int_expr(1), ["_"]),
         text_expr("B"),
         lambda(int_expr(2), ["_"])
       ]), int(2)},
      {"matchVariant default branch",
       call("matchVariant", [
         call("C", [int_expr(3)]),
         text_expr("A"),
         lambda(int_expr(1), ["_"]),
         text_expr("_"),
         lambda(int_expr(2), ["_"])
       ]), int(2)},
      {"matchVariant takes the first matching branch",
       call("matchVariant", [
         text_expr("A"),
         text_expr("A"),
         lambda(int_expr(1), ["_"]),
         text_expr("_"),
         lambda(int_expr(2), ["_"])
       ]), int(1)},
      {"matchVariant on Present",
       call("matchVariant", [
         call("Present", [int_expr(5)]),
         text_expr("Absent"),
         lambda(int_expr(0), ["_"]),
         text_expr("Present"),
         lambda(name_expr("v"), ["v"])
       ]), int(5)},
      {"replicaPoolKey",
       call("field", [call("replicaPoolKey", [text_expr("r"), call("Rec")]), text_expr("replica_id")]), text("r")},
      {"Tup", call("Tup", [int_expr(1), text_expr("a")]), tuple([int(1), text("a")])},
      {"Rec with a repeated key keeps the last",
       call("field", [call("Rec", [text_expr("a"), int_expr(1), text_expr("a"), int_expr(2)]), text_expr("a")]), int(2)}
    ]
  end

  test "and and or stop at the deciding argument like Quint" do
    # `[][0]` fails when evaluated; Quint never reaches it here.
    for {operator, first, want} <- [
          {"and", false, false},
          {"actionAll", false, false},
          {"or", true, true},
          {"actionAny", true, true}
        ] do
      assert evaluate(call(operator, [bool_expr(first), out_of_bounds()])) == bool(want), operator
    end

    assert message(fn -> evaluate(call("and", [bool_expr(true), out_of_bounds()])) end) =~ "out of bounds"
    assert evaluate(call("and", [bool_expr(true), bool_expr(true)])) == bool(true)
    assert evaluate(call("or", [bool_expr(false), bool_expr(false)])) == bool(false)
    assert message(fn -> evaluate(call("and", [int_expr(1)])) end) == "and accepts only normalized booleans"
  end

  test "every evaluator operator" do
    for {name, expression, want} <- operator_cases() do
      got = evaluate(expression)
      assert equal?(got, want), "#{name}: got #{debug(got)}, want #{debug(want)}"
    end
  end

  test "the cases above exercise every operator in the shared vocabulary" do
    used = operator_cases() |> Enum.flat_map(fn {_name, expression, _want} -> operators(expression) end) |> MapSet.new()
    # `assign` is covered by its own tests below.
    unused = Enum.reject(QuintRefinements.Vocabulary.operators(), &(&1 == "assign" or MapSet.member?(used, &1)))
    assert unused == [], "add a case for each operator the evaluator claims to implement"
  end

  defp operators(%{"operator" => operator} = expression), do: [operator | nested_operators(expression)]
  defp operators(expression), do: nested_operators(expression)

  defp nested_operators(expression) when is_map(expression),
    do: expression |> Map.values() |> Enum.flat_map(&operators/1)

  defp nested_operators(expression) when is_list(expression), do: Enum.flat_map(expression, &operators/1)
  defp nested_operators(_expression), do: []

  test "operator failures name the problem" do
    cases = [
      {call("nth", [call("List"), int_expr(0)]), "list index 0 is out of bounds"},
      {call("nth", [call("List", [int_expr(1)]), int_expr(-1)]), "list index -1 is out of bounds"},
      {call("field", [call("Rec"), text_expr("x")]), "runtime record has no field x"},
      {call("get", [call("Map"), int_expr(1)]), "map has no key Int(1)"},
      {call("set", [call("Map"), int_expr(1), int_expr(1)]), "set cannot add missing map key Int(1)"},
      {call("frobnicate", [int_expr(1)]), "unsupported runtime operator frobnicate for [Int(1)]"},
      {call("iadd", [text_expr("a"), int_expr(1)]), ~S|unsupported runtime operator iadd for [Text("a"), Int(1)]|},
      {call("Ok", [int_expr(1), int_expr(2)]), "variant constructor Ok requires one value, received 2"},
      {call("Rec", [int_expr(1), int_expr(2)]), "Rec key is not text"},
      {call("Rec", [text_expr("a")]), "Rec requires key and value pairs"},
      {call("Map", [int_expr(1)]), "Map accepts only key/value tuples"},
      {call("Map", [call("Tup", [int_expr(1)])]), "Map entries must contain exactly two values"},
      {call("ite", [int_expr(1), int_expr(1), int_expr(1)]), "ite condition is not boolean"},
      {call("ite", [bool_expr(true)]), "ite requires a condition and two branches"},
      {%{"kind" => "weird"}, "unsupported normalized expression kind"},
      {name_expr("nope"), "unknown evidence name nope"},
      {%{"kind" => "name"}, "normalized name has no value"},
      {%{"kind" => "int"}, "normalized integer has no value"},
      {%{"kind" => "int", "value" => 1.5}, "normalized integer has no value"},
      {%{"kind" => "bool", "value" => 1}, "normalized boolean has no value"},
      {%{"kind" => "str", "value" => 1}, "normalized string has no value"},
      {%{"kind" => "let", "value" => int_expr(1), "body" => int_expr(1)}, "normalized let has no name"},
      {call("matchVariant", [text_expr("C"), text_expr("A"), lambda(int_expr(1), ["_"])]),
       "matchVariant has no matching branch"},
      {call("matchVariant", [int_expr(1)]), "matchVariant value is not a normalized variant"},
      {call("matchVariant"), "matchVariant has no value"},
      {call("matchVariant", [text_expr("A"), int_expr(1), lambda(int_expr(1), ["_"])]), "matchVariant tag is not text"},
      {call("matchVariant", [text_expr("A"), text_expr("A"), int_expr(1)]), "matchVariant branch is not a lambda"},
      {call("matchVariant", [text_expr("A"), text_expr("A"), lambda(int_expr(1), [])]),
       "matchVariant lambda has no parameter"},
      {call("fold", [call("Set", [int_expr(1)]), int_expr(0), lambda(int_expr(0), ["only"])]),
       "lambda expects 1 arguments, received 2"},
      {call("fold", [call("Set", [int_expr(1)]), int_expr(0), int_expr(0)]), "expected a normalized lambda"},
      {call("fold", [call("Set", [int_expr(1)]), int_expr(0), lambda(int_expr(0), [1, 2])]),
       "normalized lambda parameter is not a name"},
      {call("fold", [call("Set")]), "fold requires a set, initial value, and lambda"},
      {call("filter", [int_expr(1), greater_than(0)]), "filter input is not a list or set"},
      {call("filter", [call("List", [int_expr(1)]), lambda(int_expr(1), ["x"])]),
       "filter predicate did not evaluate to boolean"},
      {call("filter", [call("List")]), "filter requires a list and one lambda"},
      {call("map", [call("List"), greater_than(0)]), "map input is not a set"},
      {call("mapBy", [call("Set")]), "mapBy requires a set and one lambda"},
      {call("fold", [call("List"), int_expr(0), lambda(int_expr(0), ["a", "b"])]), "fold input is not a set"},
      {call("forall", [int_expr(1), greater_than(0)]), "forall input is not a collection"},
      {call("forall", [set_of([int_expr(1)]), int_expr(1)]), "forall predicate is not a lambda"},
      {call("forall", [set_of([int_expr(1)]), lambda(int_expr(1), [])]), "forall lambda has no parameter"},
      {call("exists", [set_of([int_expr(1)]), lambda(int_expr(1), ["x"])]),
       "exists predicate did not evaluate to boolean"},
      {call("exists", [set_of([int_expr(1)])]), "exists requires a collection and one lambda"},
      {call("assign", [name_expr("state")]), "assign requires a variable and an expression"},
      {%{"kind" => "call", "arguments" => []}, "normalized call has no operator"},
      {%{"kind" => "call", "operator" => "List"}, "normalized call has no arguments"}
    ]

    for {expression, want} <- cases do
      assert message(fn -> evaluate(expression) end) =~ want
    end
  end

  test "an evidence call answers before the built-in constructor rule" do
    evidence =
      Evidence.new(fn _name -> nil end, fn operator, arguments ->
        if operator == "Custom", do: int(length(arguments))
      end)

    assert Evaluate.expression(call("Custom", [int_expr(1), int_expr(2)]), evidence) == int(2)
  end

  test "a name bound by the environment shadows the evidence" do
    evidence = Evidence.state(int(1))
    assert Evaluate.expression(name_expr("state"), evidence, %{"state" => int(2)}) == int(2)
  end

  test "evidence that raises a refinement error for Absent still yields the default" do
    evidence = Evidence.new(fn name -> QuintRefinements.Error.fail("no #{name}") end)
    assert Evaluate.expression(name_expr("Absent"), evidence) == absent()
  end

  test "structural_difference names the divergence" do
    node = fn role -> record(role: text(role)) end
    nodes = fn role -> map([{text("n1"), node.(role)}, {text("n2"), node.("Leader")}]) end

    cases = [
      {nodes.("Follower"), nodes.("Leader"),
       ~S|state.nodes["n1"].role expected Text("Follower"), observed Text("Leader")|},
      {nodes.("Leader"), map([{text("n1"), node.("Leader")}]), ~S|state.nodes["n2"] missing from observed state|},
      {map(), map([{int(3), int(1)}]), "state.nodes[3] unexpected in observed state"},
      {map([{tuple([int(1)]), int(1)}]), map(), "state.nodes[Tuple([Int(1)])] missing from observed state"},
      {record(a: int(1)), record(a: int(1), b: int(2)),
       ~S|state.nodes record fields differ; missing [], unexpected ["b"]|},
      {record(a: int(1)), record(b: int(1)), "state.nodes.a missing from observed state"},
      {list([int(1)]), list(), "state.nodes expected list length 1, observed 0"},
      {list([int(1)]), list([int(2)]), "state.nodes[0] expected Int(1), observed Int(2)"},
      {int(1), text("1"), ~S|state.nodes expected Int(1), observed Text("1")|},
      {present(int(1)), present(int(2)), "state.nodes expected Int(1), observed Int(2)"}
    ]

    for {expected, observed, want} <- cases do
      assert Evaluate.structural_difference(expected, observed, "state.nodes") == want
    end

    assert Evaluate.structural_difference(nodes.("Leader"), nodes.("Leader"), "state") == nil
    assert Evaluate.structurally_equal?(nodes.("Leader"), nodes.("Leader"))
  end

  test "a map entry the implementation lacks is not filled in from the model" do
    node = fn role -> record(role: text(role)) end
    model = record(nodes: map([{text("n1"), node.("Leader")}, {text("n2"), node.("Leader")}]))
    observed = record(nodes: map([{text("n1"), node.("Leader")}]))
    merged = Evaluate.merge_observed_state(model, observed, MapSet.new(["nodes"]))
    assert Evaluate.structural_difference(model, merged, "state") == ~S|state.nodes["n2"] missing from observed state|
  end

  test "observed state merges into the model's by shape" do
    model =
      record(
        log: list([record(term: int(1), kept: bool(true))]),
        pair: tuple([int(1), int(2)]),
        leader: present(record(id: text("a"), votes: int(1))),
        phase: variant("Running", record(step: int(1), owner: text("m"))),
        by_name: map([{text("a"), record(n: int(1), kept: bool(true))}]),
        untouched: int(7)
      )

    observed =
      record(
        log: list([record(term: int(2))]),
        pair: tuple([int(3), int(4)]),
        leader: present(record(votes: int(2))),
        phase: variant("Running", record(step: int(2))),
        by_name: record(a: record(n: int(2)))
      )

    fields = MapSet.new(["log", "pair", "leader", "phase", "by_name", "untouched", "not_observed"])

    assert Evaluate.merge_observed_state(model, observed, fields) ==
             record(
               log: list([record(term: int(2), kept: bool(true))]),
               pair: tuple([int(3), int(4)]),
               leader: present(record(id: text("a"), votes: int(2))),
               phase: variant("Running", record(step: int(2), owner: text("m"))),
               by_name: map([{text("a"), record(n: int(2), kept: bool(true))}]),
               untouched: int(7)
             )

    assert message(fn -> Evaluate.merge_observed_state(model, record(extra: int(1)), MapSet.new(["extra"])) end) ==
             "Rust action evidence contains field state.extra outside the hydrated Quint state"

    assert message(fn -> Evaluate.merge_observed_state(model, int(1), fields) end) ==
             "Rust action state evidence is not a record"

    assert message(fn -> Evaluate.merge_observed_state(int(1), observed, fields) end) ==
             "generated Quint state is not a record"
  end

  test "false assertions name the kind, context and expression" do
    evidence = empty_state()
    expression = call("eq", [int_expr(1), int_expr(2)])

    assert message(fn ->
             Evaluate.all_step_obligations("s.run", "act", [assertion(expression)], [], evidence, evidence, [])
           end) ==
             "guard assertion evaluated false in s.run:act: " <>
               ~S|{"arguments":[{"kind":"int","value":1},{"kind":"int","value":2}],"kind":"call","operator":"eq"}|

    assert message(fn ->
             Evaluate.all_step_obligations("s.run", "act", [], [assertion(int_expr(1))], evidence, evidence, [])
           end) =~ "next assertion did not evaluate to boolean in s.run:act: "
  end

  test "evaluation errors carry the scenario, action and kind as a prefix" do
    missing = [assertion(name_expr("missing"))]

    assert message(fn ->
             Evaluate.all_step_obligations("s.run", "act", [], missing, empty_state(), empty_state(), [])
           end) ==
             "s.run:act next: unknown evidence name missing"
  end

  test "an error raised by evidence keeps its scenario context" do
    evidence = Evidence.new(fn name -> if name == "boom", do: raise("boom") end)

    assert message(fn ->
             Evaluate.all_step_obligations("s", "a", [], [assertion(name_expr("boom"))], evidence, evidence, [])
           end) == "s:a next: boom"
  end

  test "unsupported dependencies fail closed" do
    evidence = empty_state()
    guard = assertion(bool_expr(true), :runtime, ["operator:igt"])

    assert message(fn -> Evaluate.all_step_obligations("s.run", "act", [guard], [], evidence, evidence, []) end) ==
             "s.run:act guard uses unsupported runtime dependency operator:igt"

    assert Evaluate.all_step_obligations("s.run", "act", [guard], [], evidence, evidence, ["operator:igt"]) == 1
    # The built-in operators need no registration.
    builtin = assertion(bool_expr(true), :runtime, ["operator:eq", "operator:assign"])
    assert Evaluate.all_step_obligations("s.run", "act", [builtin], [], evidence, evidence, []) == 1
    assert Evaluate.all_step_obligations("s.run", "act", [], [], evidence, evidence, []) == 0
  end

  test "model-scope assertions are skipped only by the runtime entry points" do
    evidence = empty_state()
    model_only = [assertion(bool_expr(false), :model)]

    assert message(fn -> Evaluate.step_obligations("s", "a", model_only, [], evidence, evidence, []) end) ==
             "s:a declared step obligations but evaluated none"

    assert message(fn -> Evaluate.all_step_obligations("s", "a", model_only, [], evidence, evidence, []) end) =~
             "guard assertion evaluated false"
  end

  test "guards see the state before the action and next sees the state after" do
    before = Evidence.state(record(n: int(1)))
    after_ = Evidence.state(record(n: int(2)))
    field = call("field", [name_expr("state"), text_expr("n")])
    guard = assertion(call("eq", [field, int_expr(1)]))
    next = assertion(call("eq", [field, int_expr(2)]))
    assert Evaluate.all_step_obligations("s", "a", [guard], [next], before, after_, []) == 2

    assert_raise QuintRefinements.Error, fn ->
      Evaluate.all_step_obligations("s", "a", [next], [guard], before, after_, [])
    end
  end

  test "assign compares the model's next state with the observed one" do
    before = Evidence.state(record(balance: int(10)))
    after_ = fn balance -> Evidence.state(record(balance: int(balance))) end
    assign = assertion(call("assign", [name_expr("state"), call("Rec", [text_expr("balance"), int_expr(6)])]))
    assert Evaluate.all_step_obligations("bank.run", "withdraw", [], [assign], before, after_.(6), []) == 1

    assert message(fn ->
             Evaluate.all_step_obligations("bank.run", "withdraw", [], [assign], before, after_.(14), [])
           end) ==
             "bank.run:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)"
  end

  test "assign reads its right-hand side from the state before the action" do
    before = Evidence.state(record(balance: int(10)))
    after_ = Evidence.state(record(balance: int(7)))
    balance = call("field", [name_expr("state"), text_expr("balance")])
    source = call("Rec", [text_expr("balance"), call("isub", [balance, int_expr(3)])])
    assign = assertion(call("assign", [name_expr("state"), source]))
    assert Evaluate.all_step_obligations("bank.run", "withdraw", [], [assign], before, after_, []) == 1
  end
end
