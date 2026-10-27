package refinements

import "sort"

// OwnershipRecord is a compile-time record: one implementation command and
// the Quint actions it refines.
//
// Refines is the ordered spec tape of one impl execution. Length 1 is a normal
// command. Length N is one source command that takes N spec steps without
// yielding (the only legal 1-to-N model).
//
// Aliases are extra JSON names for a 1-step refine. They are forbidden when
// Refines is a sequence.
//
// Actions is the legacy independent-name list (each name is its own 1-step
// run). Prefer Refines for new records.
type OwnershipRecord struct {
	// Primitive is the stable identifier of the implementation command.
	Primitive string
	// Refines are the ordered model actions refined by one command execution.
	Refines []string
	// Aliases are alternate generated names for a one-step action.
	Aliases []string
	// Actions are legacy independent action names retained for compatibility.
	Actions []string
	// Observations are the observation paths the primitive makes available.
	Observations []string
	// Retrieve are the expression dependencies the primitive can retrieve.
	Retrieve []string
}

// OwnershipTable is one package's exported ownership slice.
type OwnershipTable struct {
	// Owner is the package or module that exports the records.
	Owner string
	// Descriptors are the exported records.
	Descriptors []OwnershipRecord
}

// OwnershipDescriptor is a runtime copy of an ownership record with an
// owning package name.
type OwnershipDescriptor struct {
	Owner        string
	Primitive    string
	Refines      []string
	Aliases      []string
	Actions      []string
	Observations []string
	Retrieve     []string
}

func coverageActions(record OwnershipRecord) []string {
	var names []string
	seen := map[string]bool{}
	for _, group := range [][]string{record.Refines, record.Aliases, record.Actions} {
		for _, name := range group {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	return names
}

// CollectOwnershipRecords validates and sorts explicit ownership tables by
// primitive identifier.
func CollectOwnershipRecords(tables ...OwnershipTable) ([]OwnershipDescriptor, error) {
	var descriptors []OwnershipDescriptor
	for _, table := range tables {
		for _, record := range table.Descriptors {
			if trimSpace(record.Primitive) == "" {
				return nil, errorf("ownership record owned by %s has an empty primitive ID", table.Owner)
			}
			if len(record.Refines) > 1 && len(record.Aliases) > 0 {
				return nil, errorf("primitive %s refines a sequence and cannot declare aliases", record.Primitive)
			}
			descriptors = append(descriptors, OwnershipDescriptor{
				Owner:        table.Owner,
				Primitive:    record.Primitive,
				Refines:      append([]string(nil), record.Refines...),
				Aliases:      append([]string(nil), record.Aliases...),
				Actions:      coverageActions(record),
				Observations: append([]string(nil), record.Observations...),
				Retrieve:     append([]string(nil), record.Retrieve...),
			})
		}
	}
	sort.SliceStable(descriptors, func(i, j int) bool { return descriptors[i].Primitive < descriptors[j].Primitive })
	for i := 1; i < len(descriptors); i++ {
		if descriptors[i-1].Primitive == descriptors[i].Primitive {
			return nil, errorf("primitive ID %s is declared more than once", descriptors[i].Primitive)
		}
	}
	return descriptors, nil
}
