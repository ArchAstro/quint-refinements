package refinements

import "encoding/json"

// Expression builders for tests: they produce the decoded-JSON shape the
// evaluator interprets.

type obj = map[string]any

func call(operator string, arguments ...any) obj {
	if arguments == nil {
		arguments = []any{}
	}
	return obj{"kind": "call", "operator": operator, "arguments": arguments}
}

func intExpr(value int64) obj   { return obj{"kind": "int", "value": json.Number(itoa(value))} }
func textExpr(value string) obj { return obj{"kind": "str", "value": value} }
func boolExpr(value bool) obj   { return obj{"kind": "bool", "value": value} }
func nameExpr(value string) obj { return obj{"kind": "name", "value": value} }
func lambda(body any, parameters ...string) obj {
	names := make([]any, len(parameters))
	for i, parameter := range parameters {
		names[i] = parameter
	}
	return obj{"kind": "lambda", "parameters": names, "body": body}
}

func itoa(value int64) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func assertion(expression any) ArtifactAssertion {
	return ArtifactAssertion{Scope: ScopeRuntime, Expression: expression}
}

// noState resolves nothing.
type noState struct{}

func (noState) ResolveName(name string) (RuntimeValue, error) { return nil, errorf("no name %s", name) }
func (noState) ResolveCall(string, []RuntimeValue) (RuntimeValue, bool, error) {
	return nil, false, nil
}

func evaluate(expression any) (RuntimeValue, error) {
	return evaluateExpression(expression, allSame(noState{}), environment{})
}

func parse(text string) any {
	value, err := decodeJSON([]byte(text))
	if err != nil {
		panic(err)
	}
	return value
}
