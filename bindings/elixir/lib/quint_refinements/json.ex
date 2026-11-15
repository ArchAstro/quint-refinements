defmodule QuintRefinements.Json do
  @moduledoc """
  The decoded JSON form the artifact uses.

  Decoding is OTP's `:json`: objects are maps with binary keys (the last of a
  repeated key wins), arrays are lists, `null` is `:null`, and an integer
  literal stays an exact integer of any size. A number written with a fraction or an exponent is a float, which keeps
  `1.0` distinct from `1`.
  """

  import QuintRefinements.Error, only: [fail: 1]

  @type t :: :null | boolean() | binary() | integer() | float() | [t()] | %{optional(binary()) => t()}

  @doc "Parses one JSON document."
  @spec decode!(binary()) :: t()
  def decode!(text) when is_binary(text) do
    # When a key repeats the last one wins, as in the other runtimes.
    {value, :ok, rest} =
      :json.decode(text, :ok, %{object_finish: fn pairs, acc -> {Map.new(Enum.reverse(pairs)), acc} end})

    if String.trim(rest) != "", do: fail("invalid JSON: unexpected sequence #{inspect(rest)}")
    value
  rescue
    error in ErlangError -> fail("invalid JSON: #{describe(error.original)}")
  end

  defp describe(:unexpected_end), do: "unexpected end of JSON input"
  defp describe({:invalid_byte, byte}), do: "unexpected byte #{inspect(<<byte>>)}"
  defp describe({:unexpected_sequence, bytes}), do: "unexpected sequence #{inspect(bytes)}"
  defp describe(other), do: inspect(other)

  @doc """
  Renders a decoded value compactly with sorted object keys, the way
  `serde_json`'s `Display` does for the Rust runtime. Divergence messages quote
  expressions in this form.
  """
  @spec to_string(t()) :: String.t()
  def to_string(:null), do: "null"
  def to_string(true), do: "true"
  def to_string(false), do: "false"
  def to_string(value) when is_binary(value), do: encode_string(value)
  def to_string(value) when is_integer(value), do: Integer.to_string(value)
  def to_string(value) when is_float(value), do: Float.to_string(value)
  def to_string(value) when is_list(value), do: "[" <> Enum.map_join(value, ",", &__MODULE__.to_string/1) <> "]"

  def to_string(value) when is_map(value) do
    "{" <> Enum.map_join(sorted_keys(value), ",", &(encode_string(&1) <> ":" <> __MODULE__.to_string(value[&1]))) <> "}"
  end

  defp encode_string(value) do
    escaped = for <<codepoint::utf8 <- value>>, into: "", do: escape(codepoint)
    "\"" <> escaped <> "\""
  end

  defp escape(?"), do: "\\\""
  defp escape(?\\), do: "\\\\"
  defp escape(?\b), do: "\\b"
  defp escape(?\f), do: "\\f"
  defp escape(?\n), do: "\\n"
  defp escape(?\r), do: "\\r"
  defp escape(?\t), do: "\\t"

  defp escape(codepoint) when codepoint < 0x20 do
    "\\u" <> (codepoint |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(4, "0"))
  end

  defp escape(codepoint), do: <<codepoint::utf8>>

  @doc "Keys of a decoded object in byte order, which is also code point order."
  @spec sorted_keys(%{optional(binary()) => t()}) :: [binary()]
  def sorted_keys(object) when is_map(object), do: object |> Map.keys() |> Enum.sort()

  @doc "Reads `object[key]`, yielding `nil` when `value` is not an object or has no such key."
  @spec field(t() | nil, binary()) :: t() | nil
  def field(value, key) when is_map(value), do: Map.get(value, key)
  def field(_value, _key), do: nil

  @doc "The `kind` discriminator of a normalized expression."
  @spec kind_of(t() | nil) :: binary() | nil
  def kind_of(value) do
    case field(value, "kind") do
      kind when is_binary(kind) -> kind
      _other -> nil
    end
  end

  @doc """
  Converts an Elixir term a fixture author wrote into the decoded form, so
  equality does not depend on how the caller built it. Atom keys become
  strings and `nil` becomes `:null`.
  """
  @spec normalize(term()) :: t()
  def normalize(nil), do: :null
  def normalize(:null), do: :null
  def normalize(value) when is_boolean(value) or is_binary(value) or is_integer(value) or is_float(value), do: value
  def normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)

  def normalize(value) when is_map(value) and not is_struct(value) do
    Map.new(value, fn
      {key, nested} when is_binary(key) -> {key, normalize(nested)}
      {key, nested} when is_atom(key) -> {Atom.to_string(key), normalize(nested)}
      {key, _nested} -> fail("fixture JSON is not encodable: object key #{inspect(key)}")
    end)
  end

  def normalize(value), do: fail("fixture JSON is not encodable: #{inspect(value)}")
end
