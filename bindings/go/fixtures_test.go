package refinements

import (
	"strings"
	"testing"
)

type status string

func (s status) ArtifactJSON() any {
	return obj{"tag": string(s), "value": obj{"#tup": []any{}}}
}
func (s status) RuntimeValue() RuntimeValue { return Text(s) }

func artifactWithFixtures(t *testing.T, fixtures string) *ConformanceArtifact {
	t.Helper()
	return mustArtifact(t, strings.Replace(minimalArtifact, `"fixtures": { "m": {} }`, `"fixtures": { "m": `+fixtures+` }`, 1))
}

func TestFixtureTableFromArtifactTakesTheModelsValues(t *testing.T) {
	artifact := artifactWithFixtures(t, `{"limit": 3, "roles": {"#set": [{"tag": "A", "value": {"#tup": []}}]}}`)
	table, err := FixtureTableFromArtifact("m", artifact)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := table.Get("limit"); got != Int(3) {
		t.Errorf("limit = %v", got)
	}
	if got, _ := table.Get("roles"); !Equal(got, NewSet(Text("A"))) {
		t.Errorf("roles = %v", got)
	}
	if err := table.Validate(artifact); err != nil {
		t.Errorf("a table taken from the artifact validates: %v", err)
	}
	if names := strings.Join(table.RetrieveNames(), ","); names != "name:limit,name:roles" {
		t.Errorf("retrieve names = %s", names)
	}
}

func TestOwnedFixturesAreCheckedAgainstTheModel(t *testing.T) {
	artifact := artifactWithFixtures(t, `{"limit": 3, "roles": {"#set": [{"tag": "A", "value": {"#tup": []}}, {"tag": "B", "value": {"#tup": []}}]}}`)
	good := NewFixtureTable("m").Insert("limit", IntFixture(3)).InsertSet("roles", status("B"), status("A"))
	if err := good.Validate(artifact); err != nil {
		t.Fatalf("matching owners validate regardless of set order: %v", err)
	}

	drifted := NewFixtureTable("m").Insert("limit", IntFixture(4)).InsertSet("roles", status("A"), status("B"))
	err := drifted.Validate(artifact)
	if err == nil || err.Error() != `fixture limit JSON diverged: artifact 3 rust 4` {
		t.Errorf("drifted value: %v", err)
	}

	missing := NewFixtureTable("m").Insert("limit", IntFixture(3))
	err = missing.Validate(artifact)
	if err == nil || err.Error() != `fixture namespace m names differ: artifact ["limit", "roles"] rust ["limit"]` {
		t.Errorf("missing owner: %v", err)
	}
	if err := missing.ValidateEntries(artifact); err != nil {
		t.Errorf("entry validation tolerates extra artifact fixtures: %v", err)
	}

	err = NewFixtureTable("other").Validate(artifact)
	if err == nil || err.Error() != "fixture namespace other is missing from the artifact" {
		t.Errorf("namespace: %v", err)
	}
	err = NewFixtureTable("m").Insert("ghost", IntFixture(1)).ValidateEntries(artifact)
	if err == nil || err.Error() != "artifact namespace m is missing fixture ghost" {
		t.Errorf("ghost: %v", err)
	}
}

func TestRecordFixturesDifferInKeySubsetVersusExactMode(t *testing.T) {
	artifact := artifactWithFixtures(t, `{"org": {"id": "o1", "name": "Acme"}}`)
	partial := NewFixtureTable("m").Insert("org", jsonFixture{obj{"id": "o1"}})
	if err := partial.ValidateEntries(artifact); err != nil {
		t.Errorf("a key subset matches in entry mode: %v", err)
	}
	if err := partial.Validate(artifact); err == nil {
		t.Error("a key subset is not enough for full validation")
	}
	renamed := NewFixtureTable("m").Insert("org", jsonFixture{obj{"organization_id": "o1"}})
	if err := renamed.ValidateEntries(artifact); err == nil {
		t.Error("organization_id vs id must fail")
	}
}

type jsonFixture struct{ value obj }

func (f jsonFixture) ArtifactJSON() any          { return f.value }
func (f jsonFixture) RuntimeValue() RuntimeValue { return Record{} }

func TestScenarioNamesMustHaveAnOwner(t *testing.T) {
	text := strings.Replace(minimalArtifact,
		`{"index": 1, "kind": "action", "action": "submitInvocation", "arguments": []}`,
		`{"index": 1, "kind": "action", "action": "submitInvocation", "arguments": [],
		  "guards": [{"scope": "runtime", "expression": {"kind": "call", "operator": "contains", "arguments": [{"kind": "name", "value": "universe"}, {"kind": "name", "value": "state"}]}}]}`, 1)
	artifact := mustArtifact(t, text)
	table := NewFixtureTable("m")
	err := table.Validate(artifact)
	want := "m.run:submitInvocation names universe but neither fixtures nor snapshot state own it"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if err := table.ValidateSelected(artifact, []string{"m.other"}); err != nil {
		t.Errorf("unselected scenarios are not checked: %v", err)
	}
}

func TestExpressionNamesHonorBinders(t *testing.T) {
	expression := call("forall", nameExpr("xs"), lambda(call("eq", nameExpr("x"), nameExpr("limit")), "x"))
	if got := strings.Join(expressionNames(expression), ","); got != "xs,limit" {
		t.Errorf("names = %s", got)
	}
	let := obj{"kind": "let", "name": "y", "value": nameExpr("y"), "body": nameExpr("y")}
	if got := strings.Join(expressionNames(let), ","); got != "y" {
		t.Errorf("the let value sees outer y only: %s", got)
	}
}
