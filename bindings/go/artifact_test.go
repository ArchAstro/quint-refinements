package refinements

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const minimalArtifact = `{
  "schemaVersion": 2,
  "modelDigest": "sha256:test",
  "vocabulary": {
    "actions": ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"],
    "capabilities": ["transport.basic"],
    "expressionOperators": [],
    "expressionNames": [],
    "runtimeObservationDependencies": [],
    "runtimeObservationDependencyDigest": "sha256:test"
  },
  "fixtures": { "m": {} },
  "scenarios": [{
    "source": "m.qnt",
    "module": "m",
    "fixtureNamespace": "m",
    "name": "run",
    "requiredCapabilities": ["transport.basic"],
    "steps": [
      {"index": 0, "kind": "init", "action": "init", "arguments": []},
      {"index": 1, "kind": "action", "action": "submitInvocation", "arguments": []},
      {"index": 2, "kind": "action", "action": "selectForAttempt", "arguments": []},
      {"index": 3, "kind": "action", "action": "enqueueSelectedDelivery", "arguments": []}
    ]
  }]
}`

func mustArtifact(t *testing.T, text string) *ConformanceArtifact {
	t.Helper()
	artifact, err := ParseConformanceArtifact([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return artifact
}

func TestParsesTheSharedCorpusArtifacts(t *testing.T) {
	for _, name := range []string{"bank_withdraw", "two_phase_commit"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "conformance", "cases", name, "artifact.json"))
		if err != nil {
			t.Fatal(err)
		}
		artifact, err := ParseConformanceArtifact(data)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if artifact.SchemaVersion != 2 || len(artifact.Scenarios) == 0 {
			t.Errorf("%s: unexpected artifact %+v", name, artifact.Vocabulary)
		}
		for _, scenario := range artifact.Scenarios {
			if scenario.InitialState == nil {
				t.Errorf("%s: %s has no initial state", name, scenario.ID())
			}
		}
	}
}

func TestParseRejectsMalformedArtifacts(t *testing.T) {
	cases := []struct {
		name, from, to, want string
	}{
		{"unknown top-level field", `"schemaVersion": 2,`, `"schemaVersion": 2, "extra": 1,`, "unknown field `extra`"},
		{"missing field", `"modelDigest": "sha256:test",`, ``, "missing field `modelDigest`"},
		{"unknown step field", `"kind": "init", "action": "init"`, `"kind": "init", "action": "init", "guards": []`, "unknown field `guards`"},
		{"unknown step kind", `"kind": "init"`, `"kind": "teleport"`, "unknown variant `teleport`"},
		{"wrong type", `"schemaVersion": 2`, `"schemaVersion": "two"`, "invalid field `schemaVersion`"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text := strings.Replace(minimalArtifact, tc.from, tc.to, 1)
			if text == minimalArtifact {
				t.Fatal("test edit did not apply")
			}
			_, err := ParseConformanceArtifact([]byte(text))
			if err == nil || !strings.HasPrefix(err.Error(), "invalid refinement artifact: ") || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.want)
			}
		})
	}
	if _, err := ParseConformanceArtifact([]byte(`[]`)); err == nil {
		t.Error("an array is not an artifact")
	}
}

func TestACompleteRefinementArtifactMustUseTheEvaluatorsVocabulary(t *testing.T) {
	text := strings.Replace(minimalArtifact, `"steps": [`, `"initialState": {}, "steps": [`, 1)
	_, err := ParseConformanceArtifact([]byte(text))
	want := "artifact refinement expression vocabulary differs from the Go evaluator"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestEmbeddedVocabularyIsNotEmpty(t *testing.T) {
	if len(expressionVocabularyJSON) == 0 {
		t.Fatal("expression_vocabulary.json must be embedded")
	}
}
