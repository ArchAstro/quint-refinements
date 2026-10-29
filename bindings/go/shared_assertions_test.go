package refinements

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const eqOne = `{"scope":"runtime","expression":{"kind":"call","operator":"eq","arguments":[{"kind":"name","value":"state"},{"kind":"int","value":1}]}}`

func sharedArtifact(version int, extra, fields string) string {
	return fmt.Sprintf(`{
  "schemaVersion": %d,
  "modelDigest": "sha256:shared-assertions-test",
  "vocabulary": {
    "actions": ["step"], "capabilities": [], "expressionOperators": [], "expressionNames": [],
    "runtimeObservationDependencies": [], "runtimeObservationDependencyDigest": "sha256:test"
  },
  "fixtures": {},
  %s
  "scenarios": [{
    "source": "s.qnt", "module": "s", "fixtureNamespace": "s", "name": "run",
    "requiredCapabilities": [],
    "steps": [{"index": 1, "kind": "action", "action": "step", "arguments": [] %s}]
  }]
}`, version, extra, fields)
}

func TestV3StepsResolveTheirSharedLists(t *testing.T) {
	lists := fmt.Sprintf(`"assertionLists": [[%s], [%s, %s]],`, eqOne, eqOne, eqOne)
	artifact := mustArtifact(t, sharedArtifact(3, lists, `, "guardList": 0, "nextList": 1`))
	step := artifact.Scenarios[0].Steps[0]
	if artifact.SchemaVersion != 3 || len(step.Guards) != 1 || len(step.Next) != 2 {
		t.Fatalf("unexpected resolution: version %d, %d guards, %d next", artifact.SchemaVersion, len(step.Guards), len(step.Next))
	}
	if step.Guards[0].Scope != ScopeRuntime {
		t.Fatalf("scope = %q", step.Guards[0].Scope)
	}
}

func TestV2InlineListsStillLoad(t *testing.T) {
	fields := fmt.Sprintf(`, "guards": [%s], "next": [%s]`, eqOne, eqOne)
	artifact := mustArtifact(t, sharedArtifact(2, "", fields))
	step := artifact.Scenarios[0].Steps[0]
	if artifact.SchemaVersion != 2 || len(step.Guards) != 1 || len(step.Next) != 1 {
		t.Fatalf("unexpected v2 load: %+v", step)
	}
}

func TestV2AndV3CorpusArtifactsResolveToTheSameSteps(t *testing.T) {
	read := func(name string) *ConformanceArtifact {
		data, err := os.ReadFile(filepath.Join("..", "..", "conformance", "cases", name, "artifact.json"))
		if err != nil {
			t.Fatal(err)
		}
		return mustArtifact(t, string(data))
	}
	v2, v3 := read("bank_withdraw_v2"), read("bank_withdraw")
	if v2.SchemaVersion != 2 || v3.SchemaVersion != 3 {
		t.Fatalf("versions = %d, %d", v2.SchemaVersion, v3.SchemaVersion)
	}
	if !reflect.DeepEqual(v2.Scenarios, v3.Scenarios) {
		t.Fatal("v2 and v3 artifacts resolve to different scenarios")
	}
}

func TestSharedListsRejectBadArtifacts(t *testing.T) {
	lists := fmt.Sprintf(`"assertionLists": [[%s]],`, eqOne)
	cases := []struct{ name, artifact, want string }{
		{"guard reference out of range", sharedArtifact(3, lists, `, "guardList": 1`), "`guardList` 1 is out of range: the artifact has 1 assertion lists"},
		{"next reference without a table", sharedArtifact(3, "", `, "nextList": 0`), "`nextList` 0 is out of range"},
		{"negative reference", sharedArtifact(3, lists, `, "nextList": -1`), "`nextList` -1 is out of range"},
		{"inline in v3", sharedArtifact(3, lists, `, "guards": [`+eqOne+`]`), "inline"},
		{"list in v2", sharedArtifact(2, "", `, "guardList": 0`), "schema version 3"},
		{"table in v2", sharedArtifact(2, lists, ""), "assertionLists"},
		{"unknown version", sharedArtifact(4, "", ""), "unsupported schema version 4"},
	}
	for _, c := range cases {
		_, err := ParseConformanceArtifact([]byte(c.artifact))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error = %v, want it to contain %q", c.name, err, c.want)
		}
	}
}
