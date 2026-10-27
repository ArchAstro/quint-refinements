package refinements

import (
	"slices"
	"strings"
	"unicode"
)

func trimSpace(value string) string { return strings.TrimFunc(value, unicode.IsSpace) }

// ScheduledPrimitiveRun is one impl command the driver must run, and the Quint
// actions it fills.
type ScheduledPrimitiveRun struct {
	// Primitive is the stable identifier of the implementation command to execute.
	Primitive string
	// OwnedActions are the ordered model actions covered by this single execution.
	OwnedActions []string
}

// ScenarioActionNames returns action names from the generated scenario, in JSON order.
func ScenarioActionNames(scenario *ArtifactScenario) []string {
	var names []string
	for _, step := range scenario.Steps {
		if step.isAction() {
			names = append(names, step.Action)
		}
	}
	return names
}

type ownershipFit int

const (
	fitCompound ownershipFit = iota + 1
	fitPartialCompound
	fitSingleton
)

func fitRecord(record *OwnershipDescriptor, remaining []string) (ownershipFit, bool) {
	if len(remaining) == 0 {
		return 0, false
	}
	if len(record.Refines) > 0 {
		if len(remaining) >= len(record.Refines) && slices.Equal(remaining[:len(record.Refines)], record.Refines) {
			if len(record.Refines) > 1 {
				return fitCompound, true
			}
			return fitSingleton, true
		}
		if len(record.Refines) > 1 && remaining[0] == record.Refines[0] && len(remaining) > 1 && remaining[1] == record.Refines[1] {
			return fitPartialCompound, true
		}
		if slices.Contains(record.Aliases, remaining[0]) {
			return fitSingleton, true
		}
		return 0, false
	}
	if slices.Contains(record.Actions, remaining[0]) {
		return fitSingleton, true
	}
	return 0, false
}

// SchedulePrimitiveRuns walks generated actions against ownership records.
//
// Refines is the ordered spec tape of one impl command. JSON must present
// that sequence intact. Aliases are extra names for a 1-step refine. Legacy
// Actions lists (no Refines) stay independent 1-step runs.
func SchedulePrimitiveRuns(jsonActions []string, ownership []OwnershipDescriptor) ([]ScheduledPrimitiveRun, error) {
	var runs []ScheduledPrimitiveRun
	for index := 0; index < len(jsonActions); {
		remaining := jsonActions[index:]
		var compounds, partials, singletons []*OwnershipDescriptor
		for i := range ownership {
			record := &ownership[i]
			fit, ok := fitRecord(record, remaining)
			if !ok {
				continue
			}
			switch fit {
			case fitCompound:
				compounds = append(compounds, record)
			case fitPartialCompound:
				partials = append(partials, record)
			case fitSingleton:
				singletons = append(singletons, record)
			}
		}
		record, err := uniqueRecord(compounds, remaining[0])
		if err != nil {
			return nil, err
		}
		if record != nil {
			runs = append(runs, ScheduledPrimitiveRun{Primitive: record.Primitive, OwnedActions: slices.Clone(record.Refines)})
			index += len(record.Refines)
			continue
		}
		if len(partials) > 0 {
			count := min(len(partials[0].Refines), len(remaining))
			return nil, errorf("primitive %s JSON actions [%s] are not the owned sequence [%s]",
				partials[0].Primitive, strings.Join(remaining[:count], ", "), strings.Join(partials[0].Refines, ", "))
		}
		record, err = uniqueRecord(singletons, remaining[0])
		if err != nil {
			return nil, err
		}
		if record == nil {
			return nil, errorf("JSON action %s has no ownership record", remaining[0])
		}
		runs = append(runs, ScheduledPrimitiveRun{Primitive: record.Primitive, OwnedActions: []string{remaining[0]}})
		index++
	}
	return runs, nil
}

func uniqueRecord(records []*OwnershipDescriptor, action string) (*OwnershipDescriptor, error) {
	switch len(records) {
	case 0:
		return nil, nil
	case 1:
		return records[0], nil
	}
	primitives := make([]string, len(records))
	for i, record := range records {
		primitives[i] = record.Primitive
	}
	return nil, errorf("JSON action %s is owned by multiple primitives (%s)", action, strings.Join(primitives, ", "))
}

// CollectOwnedActionSnapshots builds init plus one retrieve-after snapshot per
// JSON action. runPrimitive runs the impl command for one scheduled tape and
// must return exactly len(ownedActions) evidences in that order.
func CollectOwnedActionSnapshots(
	scenario *ArtifactScenario,
	init Evidence,
	ownership []OwnershipDescriptor,
	runPrimitive func(primitive string, ownedActions []string) ([]Evidence, error),
) ([]Evidence, error) {
	runs, err := SchedulePrimitiveRuns(ScenarioActionNames(scenario), ownership)
	if err != nil {
		return nil, err
	}
	snapshots := []Evidence{init}
	for _, run := range runs {
		tape, err := runPrimitive(run.Primitive, run.OwnedActions)
		if err != nil {
			return nil, err
		}
		if snapshots, err = extendValidatedTape(snapshots, run, tape); err != nil {
			return nil, err
		}
	}
	return snapshots, nil
}

func extendValidatedTape(snapshots []Evidence, run ScheduledPrimitiveRun, tape []Evidence) ([]Evidence, error) {
	if len(tape) != len(run.OwnedActions) {
		return nil, errorf("primitive %s owns %d actions but returned %d evidence snapshots", run.Primitive, len(run.OwnedActions), len(tape))
	}
	return append(snapshots, tape...), nil
}
