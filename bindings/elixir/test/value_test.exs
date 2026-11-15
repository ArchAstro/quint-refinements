defmodule QuintRefinements.ValueTest do
  use ExUnit.Case, async: true

  import QuintRefinements.TestSupport, only: [message: 1]
  import QuintRefinements.Value

  alias QuintRefinements.{Access, Value}

  test "compare follows the Rust derived ordering: variant rank first, then content" do
    # bool < int < text < set < list < tuple < map < record < variant < absent < present.
    ordered = [
      bool(false),
      bool(true),
      int(-1),
      int(2),
      text("a"),
      text("b"),
      set(),
      set([int(1)]),
      set([int(1), int(2)]),
      set([int(2)]),
      list(),
      list([int(1)]),
      list([int(1), int(1)]),
      list([int(2)]),
      tuple(),
      map(),
      map([{text("a"), int(1)}]),
      map([{text("a"), int(2)}]),
      record(),
      record(a: int(1)),
      record(a: int(1), b: int(0)),
      record(b: int(0)),
      variant("A", int(1)),
      variant("B", int(0)),
      absent(),
      present(int(0)),
      present(int(1))
    ]

    for {left, i} <- Enum.with_index(ordered), {right, j} <- Enum.with_index(ordered) do
      want =
        cond do: (
               i < j -> :lt
               i > j -> :gt
               true -> :eq
             )

      assert compare(left, right) == want, "compare(#{debug(left)}, #{debug(right)})"
    end
  end

  test "integers are unbounded and compare exactly beyond 2^53" do
    big = 9_007_199_254_740_993
    assert compare(int(big), int(big + 1)) == :lt
    assert compare(int(big), int(9_007_199_254_740_992)) == :gt
    assert debug(int(Integer.pow(2, 100))) == "Int(1267650600228229401496703205376)"
  end

  test "text orders by code point, which is UTF-8 byte order" do
    assert compare(text("\u{10000}"), text("～")) == :gt
    assert compare(text("a"), text("ab")) == :lt
  end

  test "sets and maps are canonical" do
    assert equal?(set([int(2), int(1), int(2)]), set([int(1), int(2)])), "sets ignore order and duplicates"
    {:map, entries} = map = map([{text("b"), int(1)}, {text("a"), int(2)}, {text("b"), int(3)}])
    assert length(entries) == 2, "duplicate keys collapse"
    assert map_get(map, text("b")) == int(3), "the last entry wins"
    assert map_get(map, text("z")) == nil
    assert set_contains?(set([int(1)]), int(1))
    refute set_contains?(set([int(1)]), int(2))
  end

  test "map_put keeps entries ordered and replaces an existing key" do
    map = map() |> map_put(int(2), text("b")) |> map_put(int(1), text("a")) |> map_put(int(2), text("c"))
    assert map == map([{int(1), text("a")}, {int(2), text("c")}])
  end

  test "records iterate in field-name order whatever the construction order" do
    value = record(%{"b" => int(1), "a" => int(2)})
    assert record_keys(value) == ["a", "b"]
    assert record_fields(value) == [{"a", int(2)}, {"b", int(1)}]
    assert equal?(value, record(a: int(2), b: int(1)))
    assert record_put(value, "c", int(3)) == record(a: int(2), b: int(1), c: int(3))
  end

  test "debug matches Rust's Debug output" do
    value =
      record(
        flag: bool(true),
        n: int(-3),
        tags: text_set(["b", "a"]),
        items: list([text("x\"y\n"), tuple()]),
        map: map([{int(1), present(absent())}]),
        var: variant("Ok", int(1))
      )

    assert debug(value) ==
             ~S|Record({"flag": Bool(true), "items": List([Text("x\"y\n"), Tuple([])]), | <>
               ~S|"map": Map({Int(1): Present(Absent)}), "n": Int(-3), "tags": Set({Text("a"), Text("b")}), | <>
               ~S|"var": Variant { tag: "Ok", value: Int(1) }})|

    assert debug(text("tab\t nul\0 bell\a é")) == ~S|Text("tab\t nul\0 bell\u{7} é")|
  end

  test "debug escapes combining marks like Rust" do
    assert debug(text("é")) == ~S|Text("e\u{301}")|
    assert debug(text("é")) == ~S|Text("é")|
  end

  test "debug prints characters newer than the regex engine's Unicode tables" do
    assert debug(text("🥰🫠")) == ~S|Text("🥰🫠")|
    assert debug(text(<<0xA0::utf8>>)) == ~S|Text("\u{a0}")|
  end

  test "from_itf_text decodes every ITF shape" do
    cases = [
      {"bool", "true", bool(true)},
      {"int", "-4", int(-4)},
      {"bigint", ~S|{"#bigint": "9007199254740993"}|, int(9_007_199_254_740_993)},
      {"bigint beyond i64", ~S|{"#bigint": "92233720368547758080"}|, int(92_233_720_368_547_758_080)},
      {"integer literal beyond 2^53", "9007199254740993", int(9_007_199_254_740_993)},
      {"signed bigint", ~S|{"#bigint": "+5"}|, int(5)},
      {"text", ~S|"hi"|, text("hi")},
      {"surrogate pair", ~S|"😀"|, text("😀")},
      {"list", "[1, 2]", list([int(1), int(2)])},
      {"tuple", ~S|{"#tup": [1, "a"]}|, tuple([int(1), text("a")])},
      {"set", ~S|{"#set": [2, 1, 2]}|, set([int(1), int(2)])},
      {"map", ~S|{"#map": [["a", 1]]}|, map([{text("a"), int(1)}])},
      {"unit variant is text", ~S|{"tag": "Idle", "value": {"#tup": []}}|, text("Idle")},
      {"payload variant", ~S|{"tag": "Ok", "value": 1}|, variant("Ok", int(1))},
      {"absent", ~S|{"tag": "Absent", "value": {"#tup": []}}|, absent()},
      {"present", ~S|{"tag": "Present", "value": 1}|, present(int(1))},
      {"record drops meta", ~S|{"a": 1, "#meta": {}, "__x": 1}|, record(a: int(1))},
      {"long integer literal", String.pad_trailing("1", 450, "0"), int(Integer.pow(10, 449))}
    ]

    for {name, input, want} <- cases do
      got = from_itf_text(input)
      assert equal?(got, want), "#{name}: got #{debug(got)}"
    end
  end

  test "from_itf_text rejects what has no Quint value" do
    cases = [
      {~S|{"#bigint": "1.5"}|, "ITF #bigint is not an integer"},
      {~S|{"#bigint": 1}|, "ITF #bigint is not text"},
      {"1.5", "ITF number is outside normalized integer range: 1.5"},
      {"1.0", "ITF number is outside normalized integer range"},
      {"1e2", "ITF number is outside normalized integer range"},
      {"[1.0]", "ITF number is outside normalized integer range"},
      {~S|{"a": 1.5e3}|, "ITF number is outside normalized integer range"},
      {"null", "ITF null has no Quint runtime value"},
      {~S|{"#map": [["a"]]}|, "ITF #map entry is not a key/value pair"},
      {~S|{"#map": [1]}|, "ITF #map entry is not an array"},
      {~S|{"#map": 1}|, "ITF #map is not an array"},
      {~S|{"#tup": 1}|, "ITF #tup is not an array"},
      {~S|{"#set": 1}|, "ITF #set is not an array"},
      {~S|{"tag": 1, "value": 1}|, "ITF variant tag is not text"},
      {"{", "invalid ITF JSON"},
      {~S|"\ud800"|, "invalid ITF JSON"},
      {~S|"\udc00"|, "invalid ITF JSON"}
    ]

    for {input, want} <- cases do
      assert message(fn -> from_itf_text(input) end) =~ want, input
    end
  end

  test "accessors read a value or say what they found instead" do
    state = record(balance: int(10), name: text("a"), open: bool(true), log: list([int(1)]))
    assert state |> Access.field("balance") |> Access.as_int() == 10
    assert state |> Access.field("name") |> Access.as_text() == "a"
    assert state |> Access.field("open") |> Access.as_bool()
    assert state |> Access.field("log") |> Access.as_list() == [int(1)]
    assert Access.as_record(state) |> Map.keys() |> Enum.sort() == ["balance", "log", "name", "open"]
    assert message(fn -> Access.as_int(text("4")) end) == ~S|expected an integer, got Text("4")|
    assert message(fn -> Access.as_text(nil) end) == "expected text, got nothing"
    assert message(fn -> Access.field(record(a: int(1)), "b") end) == ~S|record has no field b: Record({"a": Int(1)})|
    assert message(fn -> Value.compare(int(1), :nonsense) end) =~ "not a runtime value"
  end
end
