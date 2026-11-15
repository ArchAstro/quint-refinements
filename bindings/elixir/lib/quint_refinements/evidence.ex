defmodule QuintRefinements.Evidence do
  @moduledoc """
  What an implementation shows the checker: a snapshot that resolves the names
  and calls refinement expressions use.

  The shared evaluator owns the normalized expression grammar. An
  implementation exposes only evidence that is specific to one runtime scenario
  family. Most implementations need `state/1` and nothing else.
  """

  alias QuintRefinements.Value

  @enforce_keys [:resolve_name]
  defstruct [:resolve_name, :resolve_call]

  @type resolve_name :: (String.t() -> Value.t() | nil)
  @type resolve_call :: (String.t(), [Value.t()] -> Value.t() | nil)
  @type t :: %__MODULE__{resolve_name: resolve_name(), resolve_call: resolve_call() | nil}

  @doc """
  Builds evidence from two functions.

  `resolve_name` returns the observed value of a generated name such as
  `"state"`, or `nil` when this evidence does not own the name. The optional
  `resolve_call` answers a domain-specific operator, or returns `nil` to fall
  through to the built-in evaluation.
  """
  @spec new(resolve_name(), resolve_call() | nil) :: t()
  def new(resolve_name, resolve_call \\ nil) when is_function(resolve_name, 1) do
    %__MODULE__{resolve_name: resolve_name, resolve_call: resolve_call}
  end

  @doc ~S|The common evidence: it answers only the name `"state"`.|
  @spec state(Value.t()) :: t()
  def state(state) do
    new(fn
      "state" -> state
      _name -> nil
    end)
  end

  @doc "Resolves `name`, returning `nil` when the evidence does not own it."
  @spec resolve_name(t(), String.t()) :: Value.t() | nil
  def resolve_name(%__MODULE__{resolve_name: resolve}, name), do: resolve.(name)

  @doc "Resolves a domain-specific call, returning `nil` when the evidence does not handle it."
  @spec resolve_call(t(), String.t(), [Value.t()]) :: Value.t() | nil
  def resolve_call(%__MODULE__{resolve_call: nil}, _operator, _arguments), do: nil
  def resolve_call(%__MODULE__{resolve_call: resolve}, operator, arguments), do: resolve.(operator, arguments)
end
