defmodule QuintRefinements.Error do
  @moduledoc """
  The fail-closed error raised by parsing, ownership aggregation, fixture
  validation and evaluation.

  A divergence between the implementation and the model is one of these. Its
  message matches the Rust, Go and TypeScript runtimes' diagnostics.
  """

  defexception [:message]

  @type t :: %__MODULE__{message: String.t()}

  @doc "Raises a `QuintRefinements.Error` with `message`."
  @spec fail(String.t()) :: no_return()
  def fail(message) when is_binary(message), do: raise(__MODULE__, message: message)

  @doc """
  Runs `fun` and re-raises anything it raises as a `QuintRefinements.Error`
  whose message starts with `prefix`.
  """
  @spec wrap(String.t(), (-> result)) :: result when result: var
  def wrap(prefix, fun) when is_binary(prefix) and is_function(fun, 0) do
    fun.()
  rescue
    error -> fail(prefix <> Exception.message(error))
  end
end
