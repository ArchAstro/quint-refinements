defmodule QuintRefinements.Value do
  @moduledoc """
  A normalized Quint value reconstructed from runtime-owned evidence.

  The variants mirror the Rust, Go and TypeScript bindings:

  | Quint                  | Elixir term                                  |
  |------------------------|----------------------------------------------|
  | `bool`                 | `{:bool, boolean}`                           |
  | `int`                  | `{:int, integer}` (unbounded)                |
  | `str`, unit variant    | `{:text, binary}`                            |
  | `Set[a]`               | `{:set, members}` ordered, without duplicates |
  | `List[a]`              | `{:list, items}`                             |
  | tuple                  | `{:tuple, items}`                            |
  | `a -> b`               | `{:map, [{key, value}]}` ordered by key      |
  | record                 | `{:record, %{name => value}}`                |
  | variant with a payload | `{:variant, tag, value}`                     |
  | `Absent`               | `:absent`                                    |
  | `Present(v)`           | `{:present, value}`                          |

  Build values with the constructors in this module: `set/1` and `map/1` put
  their contents in the order every binding iterates in. A unit variant of a
  Quint sum type (for example `Idle`) is a `text` value holding the constructor
  name.
  """

  import QuintRefinements.Error, only: [fail: 1]

  alias QuintRefinements.Json

  @type t ::
          {:bool, boolean()}
          | {:int, integer()}
          | {:text, binary()}
          | {:set, [t()]}
          | {:list, [t()]}
          | {:tuple, [t()]}
          | {:map, [{t(), t()}]}
          | {:record, %{optional(binary()) => t()}}
          | {:variant, binary(), t()}
          | :absent
          | {:present, t()}

  @doc "The Quint `Absent` option."
  @spec absent() :: t()
  def absent, do: :absent

  @spec bool(boolean()) :: t()
  def bool(value) when is_boolean(value), do: {:bool, value}

  @doc "Builds an integer. Quint integers are unbounded, as Elixir's are."
  @spec int(integer()) :: t()
  def int(value) when is_integer(value), do: {:int, value}

  @spec text(binary()) :: t()
  def text(value) when is_binary(value), do: {:text, value}

  @spec list(Enumerable.t(t())) :: t()
  def list(items \\ []), do: {:list, Enum.to_list(items)}

  @spec tuple(Enumerable.t(t())) :: t()
  def tuple(items \\ []), do: {:tuple, Enum.to_list(items)}

  @doc "Builds a set: members are ordered and de-duplicated structurally."
  @spec set(Enumerable.t(t())) :: t()
  def set(members \\ []) do
    # Sorted members that compare equal are adjacent.
    {:set, members |> Enum.sort(&ordered?/2) |> dedup_equal()}
  end

  defp dedup_equal([first, second | rest]) do
    if equal?(first, second), do: dedup_equal([first | rest]), else: [first | dedup_equal([second | rest])]
  end

  defp dedup_equal(members), do: members

  @doc "Builds a normalized set of text values."
  @spec text_set(Enumerable.t(binary())) :: t()
  def text_set(values), do: set(Enum.map(values, &text/1))

  @doc "Builds a map from `{key, value}` pairs. When a key repeats, the last entry wins."
  @spec map(Enumerable.t({t(), t()})) :: t()
  def map(entries \\ []) do
    sorted =
      entries
      |> Enum.to_list()
      |> Enum.sort(fn {left, _}, {right, _} -> ordered?(left, right) end)
      |> Enum.reduce([], fn
        {key, _} = entry, [{previous, _} | rest] = kept ->
          if equal?(previous, key), do: [entry | rest], else: [entry | kept]

        entry, [] ->
          [entry]
      end)
      |> Enum.reverse()

    {:map, sorted}
  end

  @doc "Builds a record from a map or from `{name, value}` pairs. Names may be strings or atoms."
  @spec record(Enumerable.t({binary() | atom(), t()})) :: t()
  def record(fields \\ %{}) do
    {:record, Map.new(fields, fn {name, value} -> {field_name(name), value} end)}
  end

  defp field_name(name) when is_binary(name), do: name
  defp field_name(name) when is_atom(name), do: Atom.to_string(name)

  @spec variant(binary(), t()) :: t()
  def variant(tag, value) when is_binary(tag), do: {:variant, tag, value}

  @spec present(t()) :: t()
  def present(value), do: {:present, value}

  @doc "A record's `{name, value}` pairs in ascending name order."
  @spec record_fields(t()) :: [{binary(), t()}]
  def record_fields({:record, fields}), do: fields |> Map.to_list() |> List.keysort(0)

  @doc "The field names of a record in ascending order."
  @spec record_keys(t()) :: [binary()]
  def record_keys({:record, fields}), do: fields |> Map.keys() |> Enum.sort()

  defp rank({:bool, _}), do: 0
  defp rank({:int, _}), do: 1
  defp rank({:text, _}), do: 2
  defp rank({:set, _}), do: 3
  defp rank({:list, _}), do: 4
  defp rank({:tuple, _}), do: 5
  defp rank({:map, _}), do: 6
  defp rank({:record, _}), do: 7
  defp rank({:variant, _, _}), do: 8
  defp rank(:absent), do: 9
  defp rank({:present, _}), do: 10
  defp rank(other), do: fail("not a runtime value: #{inspect(other)}")

  defp order(left, right) when left < right, do: :lt
  defp order(left, right) when left > right, do: :gt
  defp order(_left, _right), do: :eq

  defp compare_sequences([], []), do: :eq
  defp compare_sequences([], _right), do: :lt
  defp compare_sequences(_left, []), do: :gt

  defp compare_sequences([left | left_rest], [right | right_rest]) do
    with :eq <- compare(left, right), do: compare_sequences(left_rest, right_rest)
  end

  defp compare_pairs([], [], _first), do: :eq
  defp compare_pairs([], _right, _first), do: :lt
  defp compare_pairs(_left, [], _first), do: :gt

  defp compare_pairs([{left_key, left} | left_rest], [{right_key, right} | right_rest], first) do
    with :eq <- first.(left_key, right_key),
         :eq <- compare(left, right) do
      compare_pairs(left_rest, right_rest, first)
    end
  end

  @doc """
  Totally orders runtime values exactly as the Rust binding's derived `Ord`
  does: by variant (bool, int, text, set, list, tuple, map, record, variant,
  absent, present), then by content. Sets, maps and folds iterate in this
  order, which keeps results identical across bindings.
  """
  @spec compare(t(), t()) :: :lt | :eq | :gt
  def compare({:bool, left}, {:bool, right}), do: order(left, right)
  def compare({:int, left}, {:int, right}), do: order(left, right)
  # Binaries compare by byte, which for UTF-8 is code point order (Rust's `str` order).
  def compare({:text, left}, {:text, right}), do: order(left, right)
  def compare({:set, left}, {:set, right}), do: compare_sequences(left, right)
  def compare({:list, left}, {:list, right}), do: compare_sequences(left, right)
  def compare({:tuple, left}, {:tuple, right}), do: compare_sequences(left, right)
  def compare({:map, left}, {:map, right}), do: compare_pairs(left, right, &compare/2)

  def compare({:record, _} = left, {:record, _} = right) do
    compare_pairs(record_fields(left), record_fields(right), &order/2)
  end

  def compare({:variant, left_tag, left}, {:variant, right_tag, right}) do
    with :eq <- order(left_tag, right_tag), do: compare(left, right)
  end

  def compare(:absent, :absent), do: :eq
  def compare({:present, left}, {:present, right}), do: compare(left, right)
  def compare(left, right), do: order(rank(left), rank(right))

  defp ordered?(left, right), do: compare(left, right) != :gt

  @doc "Structural equality, the same relation as Rust's `==`."
  @spec equal?(t(), t()) :: boolean()
  def equal?(left, right), do: compare(left, right) == :eq

  @doc "Reports whether the set holds `member`."
  @spec set_contains?(t(), t()) :: boolean()
  def set_contains?({:set, members}, member), do: Enum.any?(members, &equal?(&1, member))

  @doc "Looks up a map key, returning `nil` when the map has no such key."
  @spec map_get(t(), t()) :: t() | nil
  def map_get({:map, entries}, key) do
    Enum.find_value(entries, fn {candidate, value} -> if equal?(candidate, key), do: value end)
  end

  @doc "Returns a copy of the map with `key` bound to `value`."
  @spec map_put(t(), t(), t()) :: t()
  def map_put({:map, entries}, key, value), do: {:map, insert_entry(entries, key, value)}

  defp insert_entry([], key, value), do: [{key, value}]

  defp insert_entry([{candidate, _} = entry | rest], key, value) do
    case compare(candidate, key) do
      :lt -> [entry | insert_entry(rest, key, value)]
      :eq -> [{key, value} | rest]
      :gt -> [{key, value}, entry | rest]
    end
  end

  @doc "Returns a copy of the record with `name` set to `value`."
  @spec record_put(t(), binary(), t()) :: t()
  def record_put({:record, fields}, name, value) when is_binary(name), do: {:record, Map.put(fields, name, value)}

  @doc ~S"""
  Rust's `{:?}` quoting for strings, as divergence messages print them.

  A code point is printed as itself when it is a letter, a number, punctuation,
  a symbol, a spacing mark or a space. Anything else is `\u{…}`. Rust decides
  this with the Unicode `Grapheme_Extend` property; this runtime uses the
  nonspacing and enclosing mark categories, which differ from it for a few
  dozen spacing marks. A character newer than the regex engine's Unicode tables
  is printed when Elixir considers it printable.
  """
  @spec debug_string(binary()) :: String.t()
  def debug_string(value) when is_binary(value) do
    escaped = for <<codepoint::utf8 <- value>>, into: "", do: debug_codepoint(codepoint)
    "\"" <> escaped <> "\""
  end

  defp debug_codepoint(?"), do: "\\\""
  defp debug_codepoint(?\\), do: "\\\\"
  defp debug_codepoint(?\n), do: "\\n"
  defp debug_codepoint(?\r), do: "\\r"
  defp debug_codepoint(?\t), do: "\\t"
  defp debug_codepoint(0), do: "\\0"

  defp debug_codepoint(codepoint) do
    character = <<codepoint::utf8>>

    if Regex.match?(~r/\A[\p{L}\p{Mc}\p{N}\p{P}\p{S} ]\z/u, character) or newer_printable?(character) do
      character
    else
      "\\u{" <> String.downcase(Integer.to_string(codepoint, 16)) <> "}"
    end
  end

  # The regex engine's Unicode tables are older than Elixir's: a character it
  # calls unassigned, and Elixir calls printable, was assigned since.
  defp newer_printable?(character) do
    Regex.match?(~r/\A\p{Cn}\z/u, character) and String.printable?(character)
  end

  @doc "Renders a list of values in Rust's `{:?}` notation, as divergence messages do."
  @spec debug_values([t()]) :: String.t()
  def debug_values(values), do: "[" <> Enum.map_join(values, ", ", &debug/1) <> "]"

  @doc ~S|Renders strings in Rust's `{:?}` notation: `["a", "b"]`.|
  @spec debug_strings([binary()]) :: String.t()
  def debug_strings(values), do: "[" <> Enum.map_join(values, ", ", &debug_string/1) <> "]"

  @doc """
  Renders a value in the same notation as Rust's `Debug` output, so divergence
  messages read identically in every binding.
  """
  @spec debug(t()) :: String.t()
  def debug({:bool, value}), do: "Bool(#{value})"
  def debug({:int, value}), do: "Int(#{value})"
  def debug({:text, value}), do: "Text(#{debug_string(value)})"
  def debug({:set, members}), do: "Set({" <> Enum.map_join(members, ", ", &debug/1) <> "})"
  def debug({:list, items}), do: "List(#{debug_values(items)})"
  def debug({:tuple, items}), do: "Tuple(#{debug_values(items)})"

  def debug({:map, entries}) do
    "Map({" <> Enum.map_join(entries, ", ", fn {key, value} -> "#{debug(key)}: #{debug(value)}" end) <> "})"
  end

  def debug({:record, _} = record) do
    fields =
      Enum.map_join(record_fields(record), ", ", fn {name, value} -> "#{debug_string(name)}: #{debug(value)}" end)

    "Record({" <> fields <> "})"
  end

  def debug({:variant, tag, value}), do: "Variant { tag: #{debug_string(tag)}, value: #{debug(value)} }"
  def debug(:absent), do: "Absent"
  def debug({:present, value}), do: "Present(#{debug(value)})"

  @doc """
  Decodes an ITF value (as parsed by `QuintRefinements.Json.decode!/1`) without
  collapsing maps, records, tuples, sets or variants into one another.
  """
  @spec from_itf(Json.t()) :: t()
  def from_itf(:null), do: fail("ITF null has no Quint runtime value")
  def from_itf(value) when is_boolean(value), do: bool(value)
  def from_itf(value) when is_binary(value), do: text(value)
  def from_itf(value) when is_integer(value), do: int(value)

  # The decoder yields a float only for a literal with a fraction or exponent.
  def from_itf(value) when is_float(value) do
    fail("ITF number is outside normalized integer range: #{Json.to_string(value)}")
  end

  def from_itf(value) when is_list(value), do: list(Enum.map(value, &from_itf/1))

  def from_itf(%{"#bigint" => digits}) when is_binary(digits) do
    if Regex.match?(~r/\A[+-]?[0-9]+\z/, digits) do
      int(String.to_integer(digits))
    else
      fail("ITF #bigint is not an integer: #{digits}")
    end
  end

  def from_itf(%{"#bigint" => _other}), do: fail("ITF #bigint is not text")
  def from_itf(%{"#tup" => items}), do: tuple(decode_array(items, "#tup"))
  def from_itf(%{"#set" => members}), do: set(decode_array(members, "#set"))

  def from_itf(%{"#map" => entries}) when is_list(entries) do
    entries
    |> Enum.map(fn
      [key, value] -> {from_itf(key), from_itf(value)}
      entry when is_list(entry) -> fail("ITF #map entry is not a key/value pair")
      _entry -> fail("ITF #map entry is not an array")
    end)
    |> map()
  end

  def from_itf(%{"#map" => _other}), do: fail("ITF #map is not an array")

  def from_itf(%{"tag" => tag, "value" => payload} = object) when map_size(object) == 2 do
    if not is_binary(tag), do: fail("ITF variant tag is not text")
    payload = from_itf(payload)

    case {tag, payload} do
      {"Absent", _payload} -> :absent
      {"Present", payload} -> present(payload)
      {tag, {:tuple, []}} -> text(tag)
      {tag, payload} -> variant(tag, payload)
    end
  end

  def from_itf(object) when is_map(object) do
    for key <- Json.sorted_keys(object), key != "#meta", not String.starts_with?(key, "__"), into: %{} do
      {key, from_itf(object[key])}
    end
    |> record()
  end

  defp decode_array(items, _kind) when is_list(items), do: Enum.map(items, &from_itf/1)
  defp decode_array(_items, kind), do: fail("ITF #{kind} is not an array")

  @doc "Decodes Quint's Informal Trace Format JSON text."
  @spec from_itf_text(binary()) :: t()
  def from_itf_text(source) when is_binary(source) do
    decoded =
      try do
        Json.decode!(source)
      rescue
        error in QuintRefinements.Error -> fail("invalid ITF JSON: #{error.message}")
      end

    from_itf(decoded)
  end
end
