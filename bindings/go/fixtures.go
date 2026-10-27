package refinements

import (
	"sort"
)

// QuintFixture is a Go value that owns one Quint fixture name.
//
// Implement it on the production type, not a test twin. FixtureTable.Validate
// compares ArtifactJSON to the generated JSON so field drift fails closed.
type QuintFixture interface {
	// ArtifactJSON returns the JSON shape expected in the generated artifact.
	// It may be any value encoding/json can marshal.
	ArtifactJSON() any
	// RuntimeValue returns the corresponding normalized evaluator value.
	RuntimeValue() RuntimeValue
}

// IntFixture is a Quint int fixture.
type IntFixture int64

// ArtifactJSON implements QuintFixture.
func (f IntFixture) ArtifactJSON() any { return int64(f) }

// RuntimeValue implements QuintFixture.
func (f IntFixture) RuntimeValue() RuntimeValue { return Int(f) }

// TextFixture is a Quint str fixture or unit constructor name.
type TextFixture string

// ArtifactJSON implements QuintFixture.
func (f TextFixture) ArtifactJSON() any { return string(f) }

// RuntimeValue implements QuintFixture.
func (f TextFixture) RuntimeValue() RuntimeValue { return Text(f) }

// FixtureTable holds named Quint fixtures backed by Go values, one namespace
// per model module.
type FixtureTable struct {
	// Namespace is the Quint module containing these fixture names.
	Namespace string
	values    map[string]RuntimeValue
	json      map[string]any
}

// NewFixtureTable creates an empty table for a Quint module namespace.
func NewFixtureTable(namespace string) *FixtureTable {
	return &FixtureTable{Namespace: namespace, values: map[string]RuntimeValue{}, json: map[string]any{}}
}

// FixtureTableFromArtifact creates a table that gives every fixture in a
// namespace the value the Quint model defines for it.
//
// Use this when the model's constants are plain data. Follow it with Insert or
// InsertSet to hand a name to a production value instead, so that value is
// checked against the model.
func FixtureTableFromArtifact(namespace string, artifact *ConformanceArtifact) (*FixtureTable, error) {
	table := NewFixtureTable(namespace)
	fixtures, ok := artifact.Fixtures[namespace]
	if !ok {
		return table, nil
	}
	for _, name := range sortedObjectKeys(fixtures) {
		value, err := FromITFJSON(fixtures[name])
		if err != nil {
			return nil, errorf("fixture %s: %v", name, err)
		}
		table.values[name] = value
		table.json[name] = fixtures[name]
	}
	return table, nil
}

// Insert adds one named fixture value and returns the table for chaining.
func (t *FixtureTable) Insert(name string, fixture QuintFixture) *FixtureTable {
	t.values[name] = fixture.RuntimeValue()
	t.json[name] = mustNormalize(fixture.ArtifactJSON())
	return t
}

// InsertSet adds one named finite set of fixture values and returns the table.
func (t *FixtureTable) InsertSet(name string, members ...QuintFixture) *FixtureTable {
	jsonMembers := make([]any, len(members))
	values := make([]RuntimeValue, len(members))
	for i, member := range members {
		jsonMembers[i] = mustNormalize(member.ArtifactJSON())
		values[i] = member.RuntimeValue()
	}
	sort.SliceStable(jsonMembers, func(i, j int) bool { return jsonString(jsonMembers[i]) < jsonString(jsonMembers[j]) })
	t.values[name] = NewSet(values...)
	t.json[name] = jsonMembers
	return t
}

func mustNormalize(value any) any {
	normalized, err := normalizeJSON(value)
	if err != nil {
		panic("quint-refinements: fixture JSON is not encodable: " + err.Error())
	}
	return normalized
}

// Get looks up a fixture by its generated Quint name.
func (t *FixtureTable) Get(name string) (RuntimeValue, bool) {
	value, ok := t.values[name]
	return value, ok
}

// ContainsName reports whether the table owns a generated Quint name.
func (t *FixtureTable) ContainsName(name string) bool {
	_, ok := t.values[name]
	return ok
}

// Names returns all owned fixture names in deterministic order.
func (t *FixtureTable) Names() []string {
	names := make([]string, 0, len(t.values))
	for name := range t.values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// RetrieveNames returns fixture names in generated retrieve-dependency form.
func (t *FixtureTable) RetrieveNames() []string {
	names := t.Names()
	for i, name := range names {
		names[i] = "name:" + name
	}
	return names
}

// ValidateEntries requires owned entries to exist in the artifact with
// matching JSON. Extra artifact fixtures (other records in the same Quint
// module) are allowed. Record comparison is key-subset: Go keys must exist on
// the Quint object with equal values, so organization_id vs org_id fails.
func (t *FixtureTable) ValidateEntries(artifact *ConformanceArtifact) error {
	expected, ok := artifact.Fixtures[t.Namespace]
	if !ok {
		return errorf("fixture namespace %s is missing from the artifact", t.Namespace)
	}
	for _, name := range sortedObjectKeys(t.json) {
		artifactJSON, ok := expected[name]
		if !ok {
			return errorf("artifact namespace %s is missing fixture %s", t.Namespace, name)
		}
		if !fixtureJSONMatches(t.json[name], artifactJSON, false) {
			return errorf("fixture %s JSON diverged: artifact %s rust %s", name, jsonString(artifactJSON), jsonString(t.json[name]))
		}
	}
	return nil
}

// Validate requires every JSON fixture in this namespace to have a Go owner
// with equal JSON.
func (t *FixtureTable) Validate(artifact *ConformanceArtifact) error {
	return t.ValidateSelected(artifact, nil)
}

// ValidateSelected requires every namespace fixture to have a Go owner and
// validates normalized names only in the scenario runners selected by this
// proof. An empty selection validates every scenario in the namespace.
func (t *FixtureTable) ValidateSelected(artifact *ConformanceArtifact, scenarioIDs []string) error {
	expected, ok := artifact.Fixtures[t.Namespace]
	if !ok {
		return errorf("fixture namespace %s is missing from the artifact", t.Namespace)
	}
	artifactNames := sortedObjectKeys(expected)
	ownedNames := sortedObjectKeys(t.json)
	if !equalStrings(artifactNames, ownedNames) {
		return errorf("fixture namespace %s names differ: artifact %s rust %s", t.Namespace, debugStrings(artifactNames), debugStrings(ownedNames))
	}
	for _, name := range ownedNames {
		if !fixtureJSONMatches(t.json[name], expected[name], true) {
			return errorf("fixture %s JSON diverged: artifact %s rust %s", name, jsonString(expected[name]), jsonString(t.json[name]))
		}
	}
	vocabularyNames := map[string]bool{}
	for _, name := range artifact.Vocabulary.ExpressionNames {
		vocabularyNames[name] = true
	}
	for i := range artifact.Scenarios {
		scenario := &artifact.Scenarios[i]
		if scenario.FixtureNamespace != t.Namespace {
			continue
		}
		selected := len(scenarioIDs) == 0
		for _, id := range scenarioIDs {
			selected = selected || id == scenario.ID()
		}
		if selected {
			if err := validateScenarioNames(scenario, t, vocabularyNames); err != nil {
				return err
			}
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// boundEvidence puts fixture names in front of live `state`.
type boundEvidence struct {
	fixtures *FixtureTable
	snapshot Evidence
}

func (b boundEvidence) ResolveName(name string) (RuntimeValue, error) {
	if value, ok := b.fixtures.Get(name); ok {
		return value, nil
	}
	return b.snapshot.ResolveName(name)
}

func (b boundEvidence) ResolveCall(operator string, arguments []RuntimeValue) (RuntimeValue, bool, error) {
	return b.snapshot.ResolveCall(operator, arguments)
}

// BindEvidence resolves fixture names before consulting the live snapshot.
func BindEvidence(fixtures *FixtureTable, snapshot Evidence) Evidence {
	return boundEvidence{fixtures: fixtures, snapshot: snapshot}
}

func setJSONEqual(left, right []any) bool {
	sortedStrings := func(values []any) []string {
		out := make([]string, len(values))
		for i, value := range values {
			out[i] = jsonString(value)
		}
		sort.Strings(out)
		return out
	}
	return equalStrings(sortedStrings(left), sortedStrings(right))
}

// fixtureJSONMatches compares Go-owned JSON with the artifact's. Arrays match
// an artifact "#set". With exact, objects must have identical key sets;
// otherwise the Go object's keys need only be a subset.
func fixtureJSONMatches(owned, artifact any, exact bool) bool {
	if jsonString(owned) == jsonString(artifact) {
		return true
	}
	switch owned := owned.(type) {
	case []any:
		if object, ok := artifact.(map[string]any); ok {
			if members, ok := object["#set"].([]any); ok {
				return setJSONEqual(owned, members)
			}
		}
	case map[string]any:
		if object, ok := artifact.(map[string]any); ok {
			if exact && len(owned) != len(object) {
				return false
			}
			for key, value := range owned {
				artifactValue, ok := object[key]
				if !ok || !fixtureJSONMatches(value, artifactValue, exact) {
					return false
				}
			}
			return true
		}
	}
	return false
}

func expressionNames(expression any) []string {
	return expressionNamesBound(expression, map[string]bool{})
}

func expressionNamesBound(expression any, bound map[string]bool) []string {
	kind, _ := jsonKind(expression)
	switch kind {
	case "name":
		if name, ok := jsonField(expression, "value").(string); ok && !bound[name] {
			return []string{name}
		}
	case "call":
		var names []string
		if arguments, ok := jsonField(expression, "arguments").([]any); ok {
			for _, argument := range arguments {
				names = append(names, expressionNamesBound(argument, bound)...)
			}
		}
		return names
	case "lambda":
		nested := cloneSet(bound)
		if parameters, ok := jsonField(expression, "parameters").([]any); ok {
			for _, parameter := range parameters {
				if name, ok := parameter.(string); ok {
					nested[name] = true
				}
			}
		}
		if body := jsonField(expression, "body"); body != nil {
			return expressionNamesBound(body, nested)
		}
	case "let":
		nested := cloneSet(bound)
		if name, ok := jsonField(expression, "name").(string); ok {
			nested[name] = true
		}
		var names []string
		if value := jsonField(expression, "value"); value != nil {
			names = append(names, expressionNamesBound(value, bound)...)
		}
		if body := jsonField(expression, "body"); body != nil {
			names = append(names, expressionNamesBound(body, nested)...)
		}
		return names
	}
	return nil
}

func cloneSet(set map[string]bool) map[string]bool {
	clone := make(map[string]bool, len(set)+1)
	for key := range set {
		clone[key] = true
	}
	return clone
}

func validateScenarioNames(scenario *ArtifactScenario, fixtures *FixtureTable, vocabularyNames map[string]bool) error {
	for _, step := range scenario.Steps {
		if !step.isAction() {
			continue
		}
		for _, assertion := range append(append([]ArtifactAssertion{}, step.Guards...), step.Next...) {
			for _, name := range expressionNames(assertion.Expression) {
				if name == "state" || fixtures.ContainsName(name) || vocabularyNames[name] {
					continue
				}
				return errorf("%s:%s names %s but neither fixtures nor snapshot state own it", scenario.ID(), step.Action, name)
			}
		}
	}
	return nil
}
