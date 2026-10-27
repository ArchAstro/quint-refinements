package refinements

import (
	"strings"
	"testing"
)

func TestCompareFollowsTheRustDerivedOrdering(t *testing.T) {
	// Variant rank first, then content: Bool < Int < Text < Set < List < Tuple
	// < Map < Record < Variant < Absent < Present.
	ordered := []RuntimeValue{
		Bool(false), Bool(true),
		Int(-1), Int(2),
		Text("a"), Text("b"),
		NewSet(), NewSet(Int(1)), NewSet(Int(1), Int(2)), NewSet(Int(2)),
		List{}, List{Int(1)}, List{Int(1), Int(1)}, List{Int(2)},
		Tuple{},
		NewMap(), NewMap(MapEntry{Text("a"), Int(1)}), NewMap(MapEntry{Text("a"), Int(2)}),
		Record{}, Record{"a": Int(1)}, Record{"a": Int(1), "b": Int(0)}, Record{"b": Int(0)},
		Variant{Tag: "A", Value: Int(1)}, Variant{Tag: "B", Value: Int(0)},
		Absent{},
		Present{Value: Int(0)}, Present{Value: Int(1)},
	}
	for i, left := range ordered {
		for j, right := range ordered {
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := Compare(left, right); got != want {
				t.Errorf("Compare(%s, %s) = %d, want %d", left, right, got, want)
			}
		}
	}
}

func TestSetsAndMapsAreCanonical(t *testing.T) {
	if !Equal(NewSet(Int(2), Int(1), Int(2)), NewSet(Int(1), Int(2))) {
		t.Error("sets ignore order and duplicates")
	}
	m := NewMap(MapEntry{Text("b"), Int(1)}, MapEntry{Text("a"), Int(2)}, MapEntry{Text("b"), Int(3)})
	if m.Len() != 2 {
		t.Fatalf("duplicate keys collapse, got %s", m)
	}
	if value, _ := m.Get(Text("b")); !Equal(value, Int(3)) {
		t.Errorf("the last entry wins, got %s", value)
	}
}

func TestStringMatchesRustDebug(t *testing.T) {
	value := Record{
		"flag":  Bool(true),
		"n":     Int(-3),
		"tags":  TextSet("b", "a"),
		"items": List{Text("x\"y\n"), Tuple{}},
		"map":   NewMap(MapEntry{Int(1), Present{Value: Absent{}}}),
		"var":   Variant{Tag: "Ok", Value: Int(1)},
	}
	want := `Record({"flag": Bool(true), "items": List([Text("x\"y\n"), Tuple([])]), ` +
		`"map": Map({Int(1): Present(Absent)}), "n": Int(-3), "tags": Set({Text("a"), Text("b")}), ` +
		`"var": Variant { tag: "Ok", value: Int(1) }})`
	if got := value.String(); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestFromITF(t *testing.T) {
	cases := []struct {
		name, input string
		want        RuntimeValue
		err         string
	}{
		{"bool", `true`, Bool(true), ""},
		{"int", `-4`, Int(-4), ""},
		{"bigint", `{"#bigint": "9007199254740993"}`, Int(9007199254740993), ""},
		{"bigint out of range", `{"#bigint": "9223372036854775808"}`, nil, "ITF #bigint is outside i64"},
		{"float", `1.5`, nil, "outside normalized integer range"},
		{"null", `null`, nil, "ITF null has no Quint runtime value"},
		{"text", `"hi"`, Text("hi"), ""},
		{"list", `[1, 2]`, List{Int(1), Int(2)}, ""},
		{"tuple", `{"#tup": [1, "a"]}`, Tuple{Int(1), Text("a")}, ""},
		{"set", `{"#set": [2, 1, 2]}`, NewSet(Int(1), Int(2)), ""},
		{"map", `{"#map": [["a", 1]]}`, NewMap(MapEntry{Text("a"), Int(1)}), ""},
		{"map entry shape", `{"#map": [["a"]]}`, nil, "ITF #map entry is not a key/value pair"},
		{"unit variant is text", `{"tag": "Idle", "value": {"#tup": []}}`, Text("Idle"), ""},
		{"payload variant", `{"tag": "Ok", "value": 1}`, Variant{Tag: "Ok", Value: Int(1)}, ""},
		{"absent", `{"tag": "Absent", "value": {"#tup": []}}`, Absent{}, ""},
		{"present", `{"tag": "Present", "value": 1}`, Present{Value: Int(1)}, ""},
		{"record drops meta", `{"a": 1, "#meta": {}, "__x": 1}`, Record{"a": Int(1)}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := FromITFBytes([]byte(tc.input))
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("error = %v, want %q", err, tc.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !Equal(got, tc.want) {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
}
