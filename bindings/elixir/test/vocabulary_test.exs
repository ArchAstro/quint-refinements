defmodule QuintRefinements.VocabularyTest do
  use ExUnit.Case, async: true

  test "the evaluator implements exactly the operators the compiler publishes" do
    for path <- [
          "packages/compiler/expression_vocabulary.json",
          "bindings/rust/expression_vocabulary.json",
          "bindings/go/expression_vocabulary.json"
        ] do
      published = [__DIR__, "../../..", path] |> Path.join() |> File.read!() |> :json.decode()
      assert QuintRefinements.Vocabulary.operators() == published, path
    end
  end
end
