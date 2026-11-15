defmodule QuintRefinements.JsonTest do
  use ExUnit.Case, async: true

  alias QuintRefinements.Json

  test "decode! keeps integers exact and other numbers as floats" do
    assert Json.decode!("12345678901234567890123") === 12_345_678_901_234_567_890_123
    assert Json.decode!("1.5") === 1.5
    assert Json.decode!("1e2") === 100.0
  end

  test "the last of a repeated key wins, as in the other runtimes" do
    assert Json.decode!(~S|{"a": 1, "b": {"c": 1, "c": 2}, "a": 3}|) == %{"a" => 3, "b" => %{"c" => 2}}
  end

  test "decode! decodes strings, escapes and nesting" do
    decoded = Json.decode!(~S| [ "a\né😀", true, false, null, {} ] |)
    assert decoded == ["a\né😀", true, false, :null, %{}]
    assert Json.to_string(decoded) == ~S|["a\né😀",true,false,null,{}]|
  end

  test "decode! rejects malformed documents" do
    for bad <- ["", "{", "[1,]", ~S|{"a" 1}|, "tru", ~S|"\x"|, "1 2", "01", ~S|{"a":1,}|, "\"line\nbreak\""] do
      assert_raise QuintRefinements.Error, ~r/\Ainvalid JSON: /, fn -> Json.decode!(bad) end
    end
  end

  test "to_string sorts keys compactly like serde_json" do
    decoded = Json.decode!(~S|{"b": [1, {"d": 1, "c": "x"}], "a": null, "é": true}|)
    assert Json.to_string(decoded) == ~S|{"a":null,"b":[1,{"c":"x","d":1}],"é":true}|
    assert Json.to_string(123_456_789_012_345_678_901_234_567_890) == "123456789012345678901234567890"
    assert Json.to_string("quote\" slash\\ bell\a") == ~S|"quote\" slash\\ bell\u0007"|
  end

  test "to_string keeps floats distinct from integers like serde_json" do
    assert Json.to_string(Json.decode!(~S|{"a": 1.0, "b": 1, "c": 1e2, "d": 1.5}|)) ==
             ~S|{"a":1.0,"b":1,"c":100.0,"d":1.5}|
  end

  test "normalize accepts what a fixture author writes in Elixir" do
    assert Json.normalize(%{id: "o1", tags: ["x"], parent: nil, n: 3}) == %{
             "id" => "o1",
             "tags" => ["x"],
             "parent" => :null,
             "n" => 3
           }

    assert_raise QuintRefinements.Error, ~r/fixture JSON is not encodable/, fn -> Json.normalize({:a, 1}) end
    assert_raise QuintRefinements.Error, ~r/fixture JSON is not encodable/, fn -> Json.normalize(%{1 => 2}) end
  end
end
