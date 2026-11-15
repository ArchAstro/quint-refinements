defmodule QuintRefinements.Access do
  @moduledoc """
  Typed readers for the values an implementation receives, such as an action's
  arguments or the scenario's initial state. Each one raises a
  `QuintRefinements.Error` that shows the value it did not expect.
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.Value

  defp expected(kind, nil), do: fail("expected #{kind}, got nothing")
  defp expected(kind, value), do: fail("expected #{kind}, got #{Value.debug(value)}")

  @spec as_bool(Value.t() | nil) :: boolean()
  def as_bool({:bool, value}), do: value
  def as_bool(value), do: expected("a boolean", value)

  @spec as_int(Value.t() | nil) :: integer()
  def as_int({:int, value}), do: value
  def as_int(value), do: expected("an integer", value)

  @spec as_text(Value.t() | nil) :: binary()
  def as_text({:text, value}), do: value
  def as_text(value), do: expected("text", value)

  @spec as_list(Value.t() | nil) :: [Value.t()]
  def as_list({:list, items}), do: items
  def as_list(value), do: expected("a list", value)

  @doc "Reads a record as a map from field name to value."
  @spec as_record(Value.t() | nil) :: %{optional(binary()) => Value.t()}
  def as_record({:record, fields}), do: fields
  def as_record(value), do: expected("a record", value)

  @doc "Reads one field of a record value, failing when the field is missing."
  @spec field(Value.t() | nil, binary()) :: Value.t()
  def field(value, name) when is_binary(name) do
    case as_record(value) do
      %{^name => field} -> field
      _fields -> fail("record has no field #{name}: #{Value.debug(value)}")
    end
  end
end
