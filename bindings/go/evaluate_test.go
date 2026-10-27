package refinements

import (
	"strings"
	"testing"
)

func TestAndAndOrStopAtTheDecidingArgumentLikeQuint(t *testing.T) {
	// `[][0]` fails when evaluated; Quint never reaches it here.
	outOfBounds := call("nth", call("List"), intExpr(0))
	with := func(operator string, first bool) any {
		return call(operator, boolExpr(first), outOfBounds)
	}
	for _, tc := range []struct {
		operator string
		first    bool
		want     bool
	}{{"and", false, false}, {"actionAll", false, false}, {"or", true, true}, {"actionAny", true, true}} {
		value, err := evaluate(with(tc.operator, tc.first))
		if err != nil || value != Bool(tc.want) {
			t.Errorf("%s(%t, ...) = %v, %v", tc.operator, tc.first, value, err)
		}
	}
	if _, err := evaluate(with("and", true)); err == nil {
		t.Error("a reached argument still fails")
	}
}

func TestOperators(t *testing.T) {
	set := func(values ...any) obj { return call("Set", values...) }
	record := call("Rec", textExpr("a"), intExpr(1), textExpr("b"), intExpr(2))
	tup := func(a, b any) obj { return call("Tup", a, b) }
	cases := []struct {
		name string
		expr any
		want RuntimeValue
	}{
		{"eq", call("eq", intExpr(1), intExpr(1)), Bool(true)},
		{"neq", call("neq", intExpr(1), intExpr(1)), Bool(false)},
		{"not", call("not", boolExpr(false)), Bool(true)},
		{"iadd", call("iadd", intExpr(2), intExpr(3)), Int(5)},
		{"isub", call("isub", intExpr(2), intExpr(3)), Int(-1)},
		{"ilt", call("ilt", intExpr(2), intExpr(3)), Bool(true)},
		{"igte", call("igte", intExpr(2), intExpr(3)), Bool(false)},
		{"set dedup", call("size", set(intExpr(1), intExpr(1), intExpr(2))), Int(2)},
		{"contains", call("contains", set(intExpr(1)), intExpr(1)), Bool(true)},
		{"union", call("union", set(intExpr(1)), set(intExpr(2))), NewSet(Int(1), Int(2))},
		{"exclude", call("exclude", set(intExpr(1), intExpr(2)), set(intExpr(2))), NewSet(Int(1))},
		{"field", call("field", record, textExpr("b")), Int(2)},
		{"get missing field is Absent", call("get", record, textExpr("z")), Absent{}},
		{"with", call("field", call("with", record, textExpr("a"), intExpr(9)), textExpr("a")), Int(9)},
		{"list ops", call("concat", call("append", call("List", intExpr(1)), intExpr(2)), call("List", intExpr(3))), List{Int(1), Int(2), Int(3)}},
		{"length", call("length", call("List", intExpr(1), intExpr(2))), Int(2)},
		{"nth", call("nth", call("List", intExpr(7), intExpr(8)), intExpr(1)), Int(8)},
		{"indices", call("indices", call("List", intExpr(7), intExpr(8))), NewSet(Int(0), Int(1))},
		{"map get", call("get", call("Map", tup(textExpr("k"), intExpr(1))), textExpr("k")), Int(1)},
		{"map put", call("size", call("put", call("Map"), textExpr("k"), intExpr(1))), Int(1)},
		{"map set", call("get", call("set", call("Map", tup(textExpr("k"), intExpr(1))), textExpr("k"), intExpr(2)), textExpr("k")), Int(2)},
		{"keys", call("keys", call("Map", tup(textExpr("k"), intExpr(1)))), NewSet(Text("k"))},
		{"ite", call("ite", boolExpr(false), intExpr(1), intExpr(2)), Int(2)},
		{"forall", call("forall", set(intExpr(1), intExpr(2)), lambda(call("igt", nameExpr("x"), intExpr(0)), "x")), Bool(true)},
		{"exists", call("exists", set(intExpr(1), intExpr(2)), lambda(call("igt", nameExpr("x"), intExpr(1)), "x")), Bool(true)},
		{"filter list", call("filter", call("List", intExpr(1), intExpr(2), intExpr(3)), lambda(call("igt", nameExpr("x"), intExpr(1)), "x")), List{Int(2), Int(3)}},
		{"filter set", call("filter", set(intExpr(1), intExpr(2)), lambda(call("igt", nameExpr("x"), intExpr(1)), "x")), NewSet(Int(2))},
		{"map set", call("map", set(intExpr(1), intExpr(2)), lambda(call("iadd", nameExpr("x"), intExpr(10)), "x")), NewSet(Int(11), Int(12))},
		{"mapBy", call("get", call("mapBy", set(intExpr(1)), lambda(call("iadd", nameExpr("x"), intExpr(1)), "x")), intExpr(1)), Int(2)},
		{"fold", call("fold", set(intExpr(1), intExpr(2), intExpr(3)), intExpr(0), lambda(call("iadd", nameExpr("a"), nameExpr("x")), "a", "x")), Int(6)},
		{"let", obj{"kind": "let", "name": "x", "value": intExpr(4), "body": call("iadd", nameExpr("x"), nameExpr("x"))}, Int(8)},
		{"Present", call("Present", intExpr(1)), Present{Value: Int(1)}},
		{"unknown uppercase operator builds a variant", call("Ok", intExpr(1)), Variant{Tag: "Ok", Value: Int(1)}},
		{"variant", call("variant", textExpr("Tag"), intExpr(1)), Variant{Tag: "Tag", Value: Int(1)}},
		{"Absent name defaults", nameExpr("Absent"), Absent{}},
		{"disabled name", nameExpr("disabled"), Bool(false)},
		{"matchVariant on unit", call("matchVariant", textExpr("B"), textExpr("A"), lambda(intExpr(1), "_"), textExpr("B"), lambda(intExpr(2), "_")), Int(2)},
		{"matchVariant default branch", call("matchVariant", call("C", intExpr(3)), textExpr("A"), lambda(intExpr(1), "_"), textExpr("_"), lambda(intExpr(2), "_")), Int(2)},
		{"matchVariant takes the first matching branch", call("matchVariant", textExpr("A"), textExpr("A"), lambda(intExpr(1), "_"), textExpr("_"), lambda(intExpr(2), "_")), Int(1)},
		{"matchVariant on Present", call("matchVariant", call("Present", intExpr(5)), textExpr("Absent"), lambda(intExpr(0), "_"), textExpr("Present"), lambda(nameExpr("v"), "v")), Int(5)},
		{"replicaPoolKey", call("field", call("replicaPoolKey", textExpr("r"), call("Rec")), textExpr("replica_id")), Text("r")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := evaluate(tc.expr)
			if err != nil {
				t.Fatal(err)
			}
			if !Equal(got, tc.want) {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestOperatorFailures(t *testing.T) {
	cases := []struct {
		name string
		expr any
		want string
	}{
		{"nth out of bounds", call("nth", call("List"), intExpr(0)), "list index 0 is out of bounds"},
		{"missing record field", call("field", call("Rec"), textExpr("x")), "runtime record has no field x"},
		{"missing map key", call("get", call("Map"), intExpr(1)), "map has no key Int(1)"},
		{"set adds no key", call("set", call("Map"), intExpr(1), intExpr(1)), "set cannot add missing map key Int(1)"},
		{"unknown operator", call("frobnicate", intExpr(1)), "unsupported runtime operator frobnicate for [Int(1)]"},
		{"constructor arity", call("Ok", intExpr(1), intExpr(2)), "variant constructor Ok requires one value, received 2"},
		{"rec key", call("Rec", intExpr(1), intExpr(2)), "Rec key is not text"},
		{"rec pairs", call("Rec", textExpr("a")), "Rec requires key and value pairs"},
		{"map shape", call("Map", intExpr(1)), "Map accepts only key/value tuples"},
		{"ite condition", call("ite", intExpr(1), intExpr(1), intExpr(1)), "ite condition is not boolean"},
		{"overflow", call("iadd", intExpr(9223372036854775807), intExpr(1)), "integer overflow in iadd"},
		{"underflow", call("isub", intExpr(-9223372036854775807-1), intExpr(1)), "integer overflow in isub"},
		{"unsupported kind", obj{"kind": "weird"}, "unsupported normalized expression kind"},
		{"unknown name", nameExpr("nope"), "no name nope"},
		{"matchVariant no branch", call("matchVariant", textExpr("C"), textExpr("A"), lambda(intExpr(1), "_")), "matchVariant has no matching branch"},
		{"lambda arity", call("fold", call("Set", intExpr(1)), intExpr(0), lambda(intExpr(0), "only")), "lambda expects 1 arguments, received 2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := evaluate(tc.expr)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func nodes(role string) RuntimeValue {
	node := func(role string) RuntimeValue { return Record{"role": Text(role)} }
	return NewMap(MapEntry{Text("n1"), node(role)}, MapEntry{Text("n2"), node("Leader")})
}

func TestStructuralDifferenceNamesTheDivergence(t *testing.T) {
	cases := []struct {
		name               string
		expected, observed RuntimeValue
		want               string
	}{
		{"map field", nodes("Follower"), nodes("Leader"), `state.nodes["n1"].role expected Text("Follower"), observed Text("Leader")`},
		{"missing map key", nodes("Leader"), NewMap(MapEntry{Text("n1"), Record{"role": Text("Leader")}}), `state.nodes["n2"] missing from observed state`},
		{"unexpected map key", NewMap(), NewMap(MapEntry{Int(3), Int(1)}), `state.nodes[3] unexpected in observed state`},
		{"record fields", Record{"a": Int(1)}, Record{"a": Int(1), "b": Int(2)}, `state.nodes record fields differ; missing [], unexpected ["b"]`},
		{"record key swapped", Record{"a": Int(1)}, Record{"b": Int(1)}, `state.nodes.a missing from observed state`},
		{"list length", List{Int(1)}, List{}, `state.nodes expected list length 1, observed 0`},
		{"list element", List{Int(1)}, List{Int(2)}, `state.nodes[0] expected Int(1), observed Int(2)`},
		{"scalar", Int(1), Text("1"), `state.nodes expected Int(1), observed Text("1")`},
		{"present", Present{Value: Int(1)}, Present{Value: Int(2)}, `state.nodes expected Int(1), observed Int(2)`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, differs := structuralDifference(tc.expected, tc.observed, "state.nodes")
			if !differs || got != tc.want {
				t.Errorf("got %q (%t), want %q", got, differs, tc.want)
			}
		})
	}
	if _, differs := structuralDifference(nodes("Leader"), nodes("Leader"), "state"); differs {
		t.Error("equal values do not differ")
	}
}

func TestFalseAssertionsNameTheKindContextAndExpression(t *testing.T) {
	evidence := StateEvidence{State: Record{}}
	expression := call("eq", intExpr(1), intExpr(2))
	_, err := EvaluateAllStepObligations("s.run", "act", []ArtifactAssertion{assertion(expression)}, nil, evidence, evidence, nil)
	want := `guard assertion evaluated false in s.run:act: {"arguments":[{"kind":"int","value":1},{"kind":"int","value":2}],"kind":"call","operator":"eq"}`
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v\nwant       %s", err, want)
	}
	_, err = EvaluateAllStepObligations("s.run", "act", nil, []ArtifactAssertion{assertion(intExpr(1))}, evidence, evidence, nil)
	if err == nil || !strings.HasPrefix(err.Error(), "next assertion did not evaluate to boolean in s.run:act: ") {
		t.Fatalf("error = %v", err)
	}
}

func TestUnsupportedDependenciesFailClosed(t *testing.T) {
	evidence := StateEvidence{State: Record{}}
	guard := ArtifactAssertion{Scope: ScopeRuntime, Expression: boolExpr(true), Dependencies: []string{"operator:igt"}}
	_, err := EvaluateAllStepObligations("s.run", "act", []ArtifactAssertion{guard}, nil, evidence, evidence, nil)
	if err == nil || err.Error() != "s.run:act guard uses unsupported runtime dependency operator:igt" {
		t.Fatalf("error = %v", err)
	}
	if _, err := EvaluateAllStepObligations("s.run", "act", []ArtifactAssertion{guard}, nil, evidence, evidence, []string{"operator:igt"}); err != nil {
		t.Fatalf("a registered dependency is accepted: %v", err)
	}
}

func TestModelScopeAssertionsAreSkippedOnlyByTheRuntimeEntryPoints(t *testing.T) {
	evidence := StateEvidence{State: Record{}}
	modelOnly := []ArtifactAssertion{{Scope: ScopeModel, Expression: boolExpr(false)}}
	if _, err := EvaluateStepObligations("s", "a", modelOnly, nil, evidence, evidence, nil); err == nil ||
		!strings.Contains(err.Error(), "declared step obligations but evaluated none") {
		t.Fatalf("skipped model conjuncts leave nothing evaluated: %v", err)
	}
	if _, err := EvaluateAllStepObligations("s", "a", modelOnly, nil, evidence, evidence, nil); err == nil ||
		!strings.Contains(err.Error(), "guard assertion evaluated false") {
		t.Fatalf("model conjuncts run in the full evaluator: %v", err)
	}
}
