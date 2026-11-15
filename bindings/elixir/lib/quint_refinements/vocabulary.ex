defmodule QuintRefinements.Vocabulary do
  @moduledoc """
  The refinement expression operators this evaluator implements.

  A complete artifact must publish exactly this list, in this order. The same
  list is in `packages/compiler/expression_vocabulary.json` and in the Rust, Go
  and TypeScript runtimes; `vocabulary_test.exs` fails when they differ.
  """

  @operators ~w(
    List Map Present Rec Set Tup actionAll actionAny and append assign concat
    contains eq exclude exists field filter fold forall get iadd igt igte ilt
    ilte indices isub ite keys length map mapBy matchVariant neq not nth or put
    set size union variant with
  )

  @doc "The operators, in the order an artifact publishes them."
  @spec operators() :: [String.t()]
  def operators, do: @operators
end
