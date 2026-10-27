// Package corpus executes the shared binding corpus in conformance/cases
// through the Go runtime. Every binding runs the same artifacts and must report
// the same primitive calls, obligation count, and final state.
package corpus_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
	"github.com/ArchAstro/quint-refinements/bindings/go/examples/two_phase_commit"
)

func caseFile(t *testing.T, name, file string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "conformance", "cases", name, file))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func argumentJSON(t *testing.T, value refinements.RuntimeValue) any {
	t.Helper()
	switch value := value.(type) {
	case refinements.Bool:
		return bool(value)
	case refinements.Int:
		return int64(value)
	case refinements.Text:
		return string(value)
	}
	t.Fatalf("corpus arguments are scalars; got %s", value)
	return nil
}

// recorder notes each primitive call on its way to the generated dispatcher.
type recorder struct {
	t      *testing.T
	driver *twophasecommit.Driver[*twophasecommit.Coordinator]
	calls  []any
}

func (r *recorder) RunPrimitive(primitive string, actions []refinements.ResolvedAction) ([]refinements.Evidence, error) {
	names := []any{}
	arguments := []any{}
	for _, action := range actions {
		names = append(names, action.Name)
		for _, argument := range action.Arguments {
			arguments = append(arguments, argumentJSON(r.t, argument))
		}
	}
	r.calls = append(r.calls, map[string]any{"primitive": primitive, "actions": names, "arguments": arguments})
	return r.driver.RunPrimitive(primitive, actions)
}

// normalized round-trips through JSON so numbers and slices compare by shape.
func normalized(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTwoPhaseCommitCaseMatchesTheSharedExpectation(t *testing.T) {
	// Setup: the corpus artifact and expectation, exactly as other bindings read them.
	artifact, err := refinements.ParseConformanceArtifact(caseFile(t, "two_phase_commit", "artifact.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]any
	if err := json.Unmarshal(caseFile(t, "two_phase_commit", "expected.json"), &expected); err != nil {
		t.Fatal(err)
	}
	var scenario *refinements.ArtifactScenario
	for i := range artifact.Scenarios {
		if artifact.Scenarios[i].ID() == expected["scenario"] {
			scenario = &artifact.Scenarios[i]
		}
	}
	if scenario == nil {
		t.Fatal("expected scenario is in the artifact")
	}
	ownership, err := refinements.CollectOwnershipRecords(twophasecommit.Ownership)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := twophasecommit.FixtureTable()
	if err := fixtures.Validate(artifact); err != nil {
		t.Fatalf("fixtures match: %v", err)
	}

	// Action: refine the scenario against the real coordinator.
	coordinator := twophasecommit.NewCoordinator()
	recording := &recorder{t: t, driver: &twophasecommit.Driver[*twophasecommit.Coordinator]{Implementation: coordinator}}
	evaluated, err := refinements.RefineScenario(scenario, coordinator.Snapshot(), ownership, twophasecommit.Retrieve, fixtures, recording)
	if err != nil {
		t.Fatalf("corpus scenario refines: %v", err)
	}

	// Outcome: calls, obligations, and final state all match the shared case.
	if got, want := normalized(t, recording.calls), expected["primitiveCalls"]; !reflect.DeepEqual(got, want) {
		t.Errorf("primitive calls = %v, want %v", got, want)
	}
	if got, want := normalized(t, evaluated), expected["evaluatedObligations"]; !reflect.DeepEqual(got, want) {
		t.Errorf("obligations = %v, want %v", got, want)
	}
	last := coordinator.State()
	finalState := map[string]any{"status": string(last.Status), "flushed": last.Flushed, "wal": last.Wal}
	if got, want := normalized(t, finalState), expected["finalState"]; !reflect.DeepEqual(got, want) {
		t.Errorf("final state = %v, want %v", got, want)
	}
}
