package refinements

import (
	"slices"
	"strings"
	"testing"
)

func refines(primitive string, steps ...string) OwnershipDescriptor {
	return OwnershipDescriptor{Owner: "test", Primitive: primitive, Refines: steps, Actions: steps}
}

func oneStep(primitive, step string, aliases ...string) OwnershipDescriptor {
	return OwnershipDescriptor{
		Owner: "test", Primitive: primitive, Refines: []string{step}, Aliases: aliases,
		Actions: append([]string{step}, aliases...),
	}
}

func TestConsecutiveOwnedActionsScheduleOneCompoundTape(t *testing.T) {
	steps := []string{"submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"}
	runs, err := SchedulePrimitiveRuns(steps, []OwnershipDescriptor{refines("gateway.delivery.enqueue", steps...)})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].Primitive != "gateway.delivery.enqueue" || !slices.Equal(runs[0].OwnedActions, steps) {
		t.Fatalf("runs = %+v", runs)
	}
}

func TestAliasActionsScheduleOneEvidenceEach(t *testing.T) {
	ownership := []OwnershipDescriptor{
		oneStep("gateway.connection.register", "openConnection", "openConnectionForRuntimeOwner"),
		oneStep("gateway.connection.receive_hello", "receiveHello"),
	}
	runs, err := SchedulePrimitiveRuns([]string{"openConnection", "receiveHello", "openConnectionForRuntimeOwner"}, ownership)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 3 || runs[2].Primitive != "gateway.connection.register" || !slices.Equal(runs[2].OwnedActions, []string{"openConnectionForRuntimeOwner"}) {
		t.Fatalf("runs = %+v", runs)
	}
}

func TestScheduleFailsClosed(t *testing.T) {
	steps := []string{"a", "b", "c"}
	compound := refines("p", steps...)
	cases := []struct {
		name      string
		actions   []string
		ownership []OwnershipDescriptor
		want      string
	}{
		{"partial compound", []string{"a", "b"}, []OwnershipDescriptor{compound}, "primitive p JSON actions [a, b] are not the owned sequence [a, b, c]"},
		{"unowned", []string{"z"}, []OwnershipDescriptor{compound}, "JSON action z has no ownership record"},
		{"double owner", []string{"x"}, []OwnershipDescriptor{oneStep("p1", "x"), oneStep("p2", "x")}, "JSON action x is owned by multiple primitives (p1, p2)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := SchedulePrimitiveRuns(tc.actions, tc.ownership)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestLegacyActionListsAreIndependentOneStepRuns(t *testing.T) {
	legacy := OwnershipDescriptor{Primitive: "p", Actions: []string{"a", "b"}}
	runs, err := SchedulePrimitiveRuns([]string{"a", "b"}, []OwnershipDescriptor{legacy})
	if err != nil || len(runs) != 2 {
		t.Fatalf("runs = %+v, err = %v", runs, err)
	}
}

func TestOwnershipAggregation(t *testing.T) {
	_, err := CollectOwnershipRecords(OwnershipTable{Owner: "o", Descriptors: []OwnershipRecord{{Primitive: "  "}}})
	if err == nil || err.Error() != "ownership record owned by o has an empty primitive ID" {
		t.Errorf("empty id: %v", err)
	}
	_, err = CollectOwnershipRecords(OwnershipTable{Owner: "o", Descriptors: []OwnershipRecord{{Primitive: "p", Refines: []string{"a", "b"}, Aliases: []string{"x"}}}})
	if err == nil || err.Error() != "primitive p refines a sequence and cannot declare aliases" {
		t.Errorf("aliases on compound: %v", err)
	}
	_, err = CollectOwnershipRecords(
		OwnershipTable{Owner: "o", Descriptors: []OwnershipRecord{{Primitive: "p"}}},
		OwnershipTable{Owner: "q", Descriptors: []OwnershipRecord{{Primitive: "p"}}},
	)
	if err == nil || err.Error() != "primitive ID p is declared more than once" {
		t.Errorf("duplicate id: %v", err)
	}
	descriptors, err := CollectOwnershipRecords(OwnershipTable{Owner: "o", Descriptors: []OwnershipRecord{
		{Primitive: "b", Refines: []string{"x"}, Aliases: []string{"y"}, Actions: []string{"x", "z"}},
		{Primitive: "a"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if descriptors[0].Primitive != "a" || !slices.Equal(descriptors[1].Actions, []string{"x", "y", "z"}) {
		t.Errorf("sorted and de-duplicated coverage names, got %+v", descriptors)
	}
}

func TestCompoundTapeMustReturnOneEvidencePerOwnedAction(t *testing.T) {
	artifact := mustArtifact(t, minimalArtifact)
	steps := []string{"submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"}
	ownership := []OwnershipDescriptor{refines("gateway.delivery.enqueue", steps...)}
	_, err := CollectOwnedActionSnapshots(&artifact.Scenarios[0], noState{}, ownership,
		func(string, []string) ([]Evidence, error) { return []Evidence{noState{}}, nil })
	want := "primitive gateway.delivery.enqueue owns 3 actions but returned 1 evidence snapshots"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	snapshots, err := CollectOwnedActionSnapshots(&artifact.Scenarios[0], noState{}, ownership,
		func(_ string, owned []string) ([]Evidence, error) {
			tape := make([]Evidence, len(owned))
			for i := range tape {
				tape[i] = noState{}
			}
			return tape, nil
		})
	if err != nil || len(snapshots) != 4 {
		t.Fatalf("snapshots = %d, err = %v", len(snapshots), err)
	}
	if !strings.Contains(FormatActions([]ResolvedAction{{Name: "a", Arguments: []RuntimeValue{Int(1)}}}), `ResolvedAction { name: "a", arguments: [Int(1)] }`) {
		t.Error("ResolvedAction renders like Rust's Debug")
	}
}
