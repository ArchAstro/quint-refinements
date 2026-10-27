package refinements

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// RuntimeValue is a normalized Quint value reconstructed from runtime-owned
// evidence. The concrete types mirror the Rust binding's enum variants:
//
//	Bool, Int, Text, Set, List, Tuple, Map, Record, Variant, Absent, Present
//
// Values are immutable by convention; never modify a List, Tuple, or Record
// after handing it to the runtime. Unit variants of a Quint sum type (for
// example Idle) are Text values holding the constructor name.
type RuntimeValue interface {
	runtimeValue()
	// String renders the value in the same notation as Rust's Debug output, so
	// divergence messages read identically in both bindings.
	String() string
}

type (
	// Bool is a boolean value.
	Bool bool
	// Int is a signed 64-bit integer. Like the Rust binding, the runtime does
	// not carry arbitrary-precision integers: ITF numbers outside int64 are
	// rejected rather than rounded.
	Int int64
	// Text is a text value or a unit constructor name.
	Text string
	// List is an ordered list.
	List []RuntimeValue
	// Tuple is a fixed-position tuple.
	Tuple []RuntimeValue
	// Record is keyed by field name.
	Record map[string]RuntimeValue
	// Absent is the Quint Absent option.
	Absent struct{}
	// Present is the Quint Present option and its value.
	Present struct{ Value RuntimeValue }
	// Variant is a tagged union value with a payload.
	Variant struct {
		Tag   string
		Value RuntimeValue
	}
)

// Set is a structurally keyed set. Build one with NewSet or TextSet.
type Set struct{ members []RuntimeValue }

// MapEntry is one key/value pair of a Map.
type MapEntry struct{ Key, Value RuntimeValue }

// Map keeps its keys and values structured. Build one with NewMap.
type Map struct{ entries []MapEntry }

func (Bool) runtimeValue()    {}
func (Int) runtimeValue()     {}
func (Text) runtimeValue()    {}
func (List) runtimeValue()    {}
func (Tuple) runtimeValue()   {}
func (Record) runtimeValue()  {}
func (Absent) runtimeValue()  {}
func (Present) runtimeValue() {}
func (Variant) runtimeValue() {}
func (Set) runtimeValue()     {}
func (Map) runtimeValue()     {}

// NewSet builds a set: members are ordered and de-duplicated structurally.
func NewSet(members ...RuntimeValue) Set {
	sorted := slices.Clone(members)
	slices.SortStableFunc(sorted, Compare)
	sorted = slices.CompactFunc(sorted, func(a, b RuntimeValue) bool { return Compare(a, b) == 0 })
	return Set{members: sorted}
}

// TextSet builds a normalized set of text values.
func TextSet(values ...string) Set {
	members := make([]RuntimeValue, len(values))
	for i, value := range values {
		members[i] = Text(value)
	}
	return NewSet(members...)
}

// Members returns the members in ascending structural order. Do not modify it.
func (s Set) Members() []RuntimeValue { return s.members }

// Len returns the number of members.
func (s Set) Len() int { return len(s.members) }

// Contains reports whether the set holds value.
func (s Set) Contains(value RuntimeValue) bool {
	_, found := slices.BinarySearchFunc(s.members, value, Compare)
	return found
}

// NewMap builds a map. When a key repeats, the last entry wins.
func NewMap(entries ...MapEntry) Map {
	sorted := slices.Clone(entries)
	slices.SortStableFunc(sorted, func(a, b MapEntry) int { return Compare(a.Key, b.Key) })
	result := make([]MapEntry, 0, len(sorted))
	for _, entry := range sorted {
		if n := len(result); n > 0 && Compare(result[n-1].Key, entry.Key) == 0 {
			result[n-1] = entry
			continue
		}
		result = append(result, entry)
	}
	return Map{entries: result}
}

// Entries returns the entries in ascending key order. Do not modify it.
func (m Map) Entries() []MapEntry { return m.entries }

// Len returns the number of entries.
func (m Map) Len() int { return len(m.entries) }

// Get looks up a key.
func (m Map) Get(key RuntimeValue) (RuntimeValue, bool) {
	index, found := slices.BinarySearchFunc(m.entries, key, func(e MapEntry, k RuntimeValue) int {
		return Compare(e.Key, k)
	})
	if !found {
		return nil, false
	}
	return m.entries[index].Value, true
}

func (m Map) with(key, value RuntimeValue) Map {
	index, found := slices.BinarySearchFunc(m.entries, key, func(e MapEntry, k RuntimeValue) int {
		return Compare(e.Key, k)
	})
	entries := slices.Clone(m.entries)
	if found {
		entries[index] = MapEntry{Key: key, Value: value}
	} else {
		entries = slices.Insert(entries, index, MapEntry{Key: key, Value: value})
	}
	return Map{entries: entries}
}

func (r Record) with(key string, value RuntimeValue) Record {
	updated := make(Record, len(r)+1)
	for k, v := range r {
		updated[k] = v
	}
	updated[key] = value
	return updated
}

func (r Record) sortedKeys() []string {
	keys := make([]string, 0, len(r))
	for key := range r {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func rank(value RuntimeValue) int {
	switch value.(type) {
	case Bool:
		return 0
	case Int:
		return 1
	case Text:
		return 2
	case Set:
		return 3
	case List:
		return 4
	case Tuple:
		return 5
	case Map:
		return 6
	case Record:
		return 7
	case Variant:
		return 8
	case Absent:
		return 9
	case Present:
		return 10
	}
	return -1
}

func compareSlices(a, b []RuntimeValue) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := Compare(a[i], b[i]); c != 0 {
			return c
		}
	}
	return compareInts(len(a), len(b))
}

func compareInts(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// Compare totally orders runtime values exactly as the Rust binding's derived
// Ord does: by variant (Bool, Int, Text, Set, List, Tuple, Map, Record,
// Variant, Absent, Present), then by content. Sets, Maps, and folds iterate in
// this order, which is what keeps results identical across bindings.
func Compare(a, b RuntimeValue) int {
	ra, rb := rank(a), rank(b)
	if ra != rb {
		return compareInts(ra, rb)
	}
	switch left := a.(type) {
	case Bool:
		right := b.(Bool)
		switch {
		case left == right:
			return 0
		case !bool(left):
			return -1
		}
		return 1
	case Int:
		right := b.(Int)
		switch {
		case left < right:
			return -1
		case left > right:
			return 1
		}
		return 0
	case Text:
		return strings.Compare(string(left), string(b.(Text)))
	case Set:
		return compareSlices(left.members, b.(Set).members)
	case List:
		return compareSlices(left, b.(List))
	case Tuple:
		return compareSlices(left, b.(Tuple))
	case Map:
		right := b.(Map)
		for i := 0; i < len(left.entries) && i < len(right.entries); i++ {
			if c := Compare(left.entries[i].Key, right.entries[i].Key); c != 0 {
				return c
			}
			if c := Compare(left.entries[i].Value, right.entries[i].Value); c != 0 {
				return c
			}
		}
		return compareInts(len(left.entries), len(right.entries))
	case Record:
		right := b.(Record)
		leftKeys, rightKeys := left.sortedKeys(), right.sortedKeys()
		for i := 0; i < len(leftKeys) && i < len(rightKeys); i++ {
			if c := strings.Compare(leftKeys[i], rightKeys[i]); c != 0 {
				return c
			}
			if c := Compare(left[leftKeys[i]], right[rightKeys[i]]); c != 0 {
				return c
			}
		}
		return compareInts(len(leftKeys), len(rightKeys))
	case Variant:
		right := b.(Variant)
		if c := strings.Compare(left.Tag, right.Tag); c != 0 {
			return c
		}
		return Compare(left.Value, right.Value)
	case Absent:
		return 0
	case Present:
		return Compare(left.Value, b.(Present).Value)
	}
	return 0
}

// Equal reports structural equality, the same relation as Rust's `==`.
func Equal(a, b RuntimeValue) bool { return Compare(a, b) == 0 }

// String implementations replicate Rust's derived Debug output.

func (v Bool) String() string    { return fmt.Sprintf("Bool(%t)", bool(v)) }
func (v Int) String() string     { return fmt.Sprintf("Int(%d)", int64(v)) }
func (v Text) String() string    { return "Text(" + debugString(string(v)) + ")" }
func (v Absent) String() string  { return "Absent" }
func (v Present) String() string { return "Present(" + v.Value.String() + ")" }
func (v List) String() string    { return "List(" + debugList([]RuntimeValue(v)) + ")" }
func (v Tuple) String() string   { return "Tuple(" + debugList([]RuntimeValue(v)) + ")" }
func (v Set) String() string {
	parts := make([]string, len(v.members))
	for i, member := range v.members {
		parts[i] = member.String()
	}
	return "Set({" + strings.Join(parts, ", ") + "})"
}
func (v Map) String() string {
	parts := make([]string, len(v.entries))
	for i, entry := range v.entries {
		parts[i] = entry.Key.String() + ": " + entry.Value.String()
	}
	return "Map({" + strings.Join(parts, ", ") + "})"
}
func (v Record) String() string {
	keys := v.sortedKeys()
	parts := make([]string, len(keys))
	for i, key := range keys {
		parts[i] = debugString(key) + ": " + v[key].String()
	}
	return "Record({" + strings.Join(parts, ", ") + "})"
}
func (v Variant) String() string {
	return "Variant { tag: " + debugString(v.Tag) + ", value: " + v.Value.String() + " }"
}

func debugList(values []RuntimeValue) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = value.String()
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func debugValues(values []RuntimeValue) string { return debugList(values) }

func debugStrings(values []string) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = debugString(value)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// debugString quotes a string the way Rust's `{:?}` does.
func debugString(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		case 0:
			out.WriteString(`\0`)
		default:
			if unicode.IsPrint(r) || r == ' ' {
				out.WriteRune(r)
			} else {
				fmt.Fprintf(&out, `\u{%x}`, r)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

// FromITFBytes decodes Quint's Informal Trace Format JSON text.
func FromITFBytes(data []byte) (RuntimeValue, error) {
	decoded, err := decodeJSON(data)
	if err != nil {
		return nil, errorf("invalid ITF JSON: %v", err)
	}
	return FromITFJSON(decoded)
}

// FromITFJSON decodes an ITF value (as produced by encoding/json with
// UseNumber) without collapsing maps, records, tuples, sets, or variants into
// one another. Plain float64 numbers are accepted when they are integral.
func FromITFJSON(value any) (RuntimeValue, error) {
	switch value := value.(type) {
	case bool:
		return Bool(value), nil
	case string:
		return Text(value), nil
	case json.Number:
		parsed, err := strconv.ParseInt(value.String(), 10, 64)
		if err != nil {
			return nil, errorf("ITF number is outside normalized integer range: %s", value)
		}
		return Int(parsed), nil
	case float64:
		const exact = 1 << 53
		if value != float64(int64(value)) || value > exact || value < -exact {
			return nil, errorf("ITF number is outside normalized integer range: %v", value)
		}
		return Int(int64(value)), nil
	case int:
		return Int(value), nil
	case int64:
		return Int(value), nil
	case []any:
		items, err := decodeITFValues(value)
		if err != nil {
			return nil, err
		}
		return List(items), nil
	case map[string]any:
		return fromITFObject(value)
	case nil:
		return nil, errorf("ITF null has no Quint runtime value")
	}
	return nil, errorf("ITF value of type %T has no Quint runtime value", value)
}

func fromITFObject(object map[string]any) (RuntimeValue, error) {
	if big, ok := object["#bigint"]; ok {
		text, ok := big.(string)
		if !ok {
			return nil, errorf("ITF #bigint is not text")
		}
		parsed, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return nil, errorf("ITF #bigint is outside i64: %v", err)
		}
		return Int(parsed), nil
	}
	if values, ok := object["#tup"]; ok {
		items, err := decodeITFArray(values, "#tup")
		if err != nil {
			return nil, err
		}
		return Tuple(items), nil
	}
	if values, ok := object["#set"]; ok {
		items, err := decodeITFArray(values, "#set")
		if err != nil {
			return nil, err
		}
		return NewSet(items...), nil
	}
	if entries, ok := object["#map"]; ok {
		list, ok := entries.([]any)
		if !ok {
			return nil, errorf("ITF #map is not an array")
		}
		decoded := make([]MapEntry, 0, len(list))
		for _, entry := range list {
			pair, ok := entry.([]any)
			if !ok {
				return nil, errorf("ITF #map entry is not an array")
			}
			if len(pair) != 2 {
				return nil, errorf("ITF #map entry is not a key/value pair")
			}
			key, err := FromITFJSON(pair[0])
			if err != nil {
				return nil, err
			}
			value, err := FromITFJSON(pair[1])
			if err != nil {
				return nil, err
			}
			decoded = append(decoded, MapEntry{Key: key, Value: value})
		}
		return NewMap(decoded...), nil
	}
	_, hasTag := object["tag"]
	_, hasValue := object["value"]
	if len(object) == 2 && hasTag && hasValue {
		tag, ok := object["tag"].(string)
		if !ok {
			return nil, errorf("ITF variant tag is not text")
		}
		value, err := FromITFJSON(object["value"])
		if err != nil {
			return nil, err
		}
		if tag == "Absent" {
			return Absent{}, nil
		}
		if tag == "Present" {
			return Present{Value: value}, nil
		}
		if tuple, ok := value.(Tuple); ok && len(tuple) == 0 {
			return Text(tag), nil
		}
		return Variant{Tag: tag, Value: value}, nil
	}
	record := Record{}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := object[key]
		if key == "#meta" || strings.HasPrefix(key, "__") {
			continue
		}
		decoded, err := FromITFJSON(value)
		if err != nil {
			return nil, err
		}
		record[key] = decoded
	}
	return record, nil
}

func decodeITFArray(value any, kind string) ([]RuntimeValue, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, errorf("ITF %s is not an array", kind)
	}
	return decodeITFValues(list)
}

func decodeITFValues(values []any) ([]RuntimeValue, error) {
	decoded := make([]RuntimeValue, len(values))
	for i, value := range values {
		item, err := FromITFJSON(value)
		if err != nil {
			return nil, err
		}
		decoded[i] = item
	}
	return decoded, nil
}
