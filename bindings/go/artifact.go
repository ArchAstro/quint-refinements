package refinements

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
)

//go:embed expression_vocabulary.json
var expressionVocabularyJSON []byte

// ConformanceArtifact is the frozen schema-v2 conformance artifact exported
// from the Quint model.
type ConformanceArtifact struct {
	// SchemaVersion is the version of the generated artifact schema.
	SchemaVersion uint32
	// ModelDigest is the digest of the Quint model inputs used during generation.
	ModelDigest string
	// Vocabulary is the closed action, capability, expression, and observation vocabulary.
	Vocabulary ArtifactVocabulary
	// Fixtures holds generated fixture values keyed by model namespace and fixture name.
	Fixtures map[string]map[string]any
	// Scenarios are the ordered scenarios generated from model runs.
	Scenarios []ArtifactScenario
}

// ArtifactVocabulary is the closed vocabulary published by the trace generator.
type ArtifactVocabulary struct {
	Actions                            []string
	Capabilities                       []string
	ExpressionOperators                []string
	ExpressionNames                    []string
	RefinementExpressionOperators      []string
	RuntimeObservationDependencies     []string
	RuntimeObservationDependencyDigest string
}

// ArtifactScenario is one ordered conformance scenario.
type ArtifactScenario struct {
	Source               string
	Module               string
	FixtureNamespace     string
	Name                 string
	RequiredCapabilities []string
	// InitialState is the complete generated initial model state (ITF JSON),
	// or nil when full refinement is not enabled for the scenario.
	InitialState any
	Steps        []ArtifactStep
}

// ID is the stable scenario identifier used by the coverage report.
func (s ArtifactScenario) ID() string { return s.Module + "." + s.Name }

// StepKind discriminates scenario steps.
type StepKind string

const (
	// StepInit is an initializer step that precedes all implementation actions.
	StepInit StepKind = "init"
	// StepAction is a model action owned by an implementation primitive.
	StepAction StepKind = "action"
	// StepObserve is an observation-only step evaluated against the current snapshot.
	StepObserve StepKind = "observe"
)

// ArtifactStep is one init, action, or observe step. Which fields are set
// depends on Kind: Init and Action carry Action and Arguments, Action also
// carries Guards and Next, and Observe carries Assertions.
type ArtifactStep struct {
	Kind       StepKind
	Index      int
	Action     string
	Arguments  []any
	Guards     []ArtifactAssertion
	Next       []ArtifactAssertion
	Assertions []ArtifactAssertion
}

// AssertionScope says whether an assertion is runtime-evaluated or extracted from the model.
type AssertionScope string

const (
	// ScopeRuntime is an assertion supplied by a runtime observation adapter.
	ScopeRuntime AssertionScope = "runtime"
	// ScopeModel is an assertion extracted directly from the model action.
	ScopeModel AssertionScope = "model"
)

// ArtifactAssertion carries assertion provenance and normalized dependencies.
type ArtifactAssertion struct {
	Scope AssertionScope
	// Expression is the normalized expression tree (decoded JSON) interpreted by the evaluator.
	Expression   any
	Dependencies []string
}

// ParseConformanceArtifact parses the checked JSON artifact without
// interpreting Quint source.
func ParseConformanceArtifact(data []byte) (*ConformanceArtifact, error) {
	artifact, err := decodeArtifact(data)
	if err != nil {
		return nil, errorf("invalid refinement artifact: %v", err)
	}
	var expected []string
	if err := json.Unmarshal(expressionVocabularyJSON, &expected); err != nil {
		return nil, errorf("invalid embedded expression vocabulary: %v", err)
	}
	complete := false
	for _, scenario := range artifact.Scenarios {
		if scenario.InitialState != nil {
			complete = true
		}
	}
	if complete && !slices.Equal(artifact.Vocabulary.RefinementExpressionOperators, expected) {
		return nil, errorf("artifact refinement expression vocabulary differs from the Go evaluator")
	}
	return artifact, nil
}

// object is a strict JSON object reader: required fields must exist and any
// field that is not consumed is rejected, like serde's deny_unknown_fields.
type object struct {
	fields   map[string]json.RawMessage
	consumed map[string]bool
	err      error
	name     string
}

func newObject(raw json.RawMessage, name string) (*object, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("%s must be an object", name)
	}
	return &object{fields: fields, consumed: map[string]bool{}, name: name}, nil
}

func (o *object) read(key string, required bool, target any) bool {
	o.consumed[key] = true
	raw, ok := o.fields[key]
	if !ok {
		if required && o.err == nil {
			o.err = fmt.Errorf("missing field `%s`", key)
		}
		return false
	}
	decoder := json.NewDecoder(bytesReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil && o.err == nil {
		o.err = fmt.Errorf("invalid field `%s`: %v", key, err)
		return false
	}
	return true
}

func (o *object) finish() error {
	if o.err != nil {
		return o.err
	}
	for _, key := range sortedRawKeys(o.fields) {
		if !o.consumed[key] {
			return fmt.Errorf("unknown field `%s` in %s", key, o.name)
		}
	}
	return nil
}

func decodeArtifact(data []byte) (*ConformanceArtifact, error) {
	var raw json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	root, err := newObject(raw, "artifact")
	if err != nil {
		return nil, err
	}
	artifact := &ConformanceArtifact{}
	root.read("schemaVersion", true, &artifact.SchemaVersion)
	root.read("modelDigest", true, &artifact.ModelDigest)
	var vocabulary, scenarios json.RawMessage
	root.read("vocabulary", true, &vocabulary)
	root.read("fixtures", true, &artifact.Fixtures)
	root.read("scenarios", true, &scenarios)
	if err := root.finish(); err != nil {
		return nil, err
	}
	if artifact.Vocabulary, err = decodeVocabulary(vocabulary); err != nil {
		return nil, err
	}
	var rawScenarios []json.RawMessage
	if err := json.Unmarshal(scenarios, &rawScenarios); err != nil {
		return nil, fmt.Errorf("invalid field `scenarios`: %v", err)
	}
	for _, rawScenario := range rawScenarios {
		scenario, err := decodeScenario(rawScenario)
		if err != nil {
			return nil, err
		}
		artifact.Scenarios = append(artifact.Scenarios, scenario)
	}
	return artifact, nil
}

func decodeVocabulary(raw json.RawMessage) (ArtifactVocabulary, error) {
	var v ArtifactVocabulary
	o, err := newObject(raw, "vocabulary")
	if err != nil {
		return v, err
	}
	o.read("actions", true, &v.Actions)
	o.read("capabilities", true, &v.Capabilities)
	o.read("expressionOperators", true, &v.ExpressionOperators)
	o.read("expressionNames", true, &v.ExpressionNames)
	o.read("refinementExpressionOperators", false, &v.RefinementExpressionOperators)
	o.read("runtimeObservationDependencies", true, &v.RuntimeObservationDependencies)
	o.read("runtimeObservationDependencyDigest", true, &v.RuntimeObservationDependencyDigest)
	return v, o.finish()
}

func decodeScenario(raw json.RawMessage) (ArtifactScenario, error) {
	var s ArtifactScenario
	o, err := newObject(raw, "scenario")
	if err != nil {
		return s, err
	}
	var steps []json.RawMessage
	o.read("source", true, &s.Source)
	o.read("module", true, &s.Module)
	o.read("fixtureNamespace", true, &s.FixtureNamespace)
	o.read("name", true, &s.Name)
	o.read("requiredCapabilities", true, &s.RequiredCapabilities)
	o.read("initialState", false, &s.InitialState)
	o.read("steps", true, &steps)
	if err := o.finish(); err != nil {
		return s, err
	}
	for _, rawStep := range steps {
		step, err := decodeStep(rawStep)
		if err != nil {
			return s, err
		}
		s.Steps = append(s.Steps, step)
	}
	return s, nil
}

func decodeStep(raw json.RawMessage) (ArtifactStep, error) {
	var step ArtifactStep
	o, err := newObject(raw, "step")
	if err != nil {
		return step, err
	}
	var kind string
	if !o.read("kind", true, &kind) {
		return step, o.finish()
	}
	step.Kind = StepKind(kind)
	var guards, next, assertions []json.RawMessage
	switch step.Kind {
	case StepInit:
		o.read("index", true, &step.Index)
		o.read("action", true, &step.Action)
		o.read("arguments", true, &step.Arguments)
	case StepAction:
		o.read("index", true, &step.Index)
		o.read("action", true, &step.Action)
		o.read("arguments", true, &step.Arguments)
		o.read("guards", false, &guards)
		o.read("next", false, &next)
	case StepObserve:
		o.read("index", true, &step.Index)
		o.read("assertions", true, &assertions)
	default:
		return step, fmt.Errorf("unknown variant `%s`, expected one of `init`, `action`, `observe`", kind)
	}
	if err := o.finish(); err != nil {
		return step, err
	}
	if step.Guards, err = decodeAssertions(guards); err != nil {
		return step, err
	}
	if step.Next, err = decodeAssertions(next); err != nil {
		return step, err
	}
	if step.Assertions, err = decodeAssertions(assertions); err != nil {
		return step, err
	}
	return step, nil
}

func decodeAssertions(raws []json.RawMessage) ([]ArtifactAssertion, error) {
	var assertions []ArtifactAssertion
	for _, raw := range raws {
		o, err := newObject(raw, "assertion")
		if err != nil {
			return nil, err
		}
		var assertion ArtifactAssertion
		var scope string
		o.read("scope", true, &scope)
		o.read("expression", true, &assertion.Expression)
		o.read("dependencies", false, &assertion.Dependencies)
		if err := o.finish(); err != nil {
			return nil, err
		}
		switch AssertionScope(scope) {
		case ScopeRuntime, ScopeModel:
			assertion.Scope = AssertionScope(scope)
		default:
			return nil, fmt.Errorf("unknown variant `%s`, expected `runtime` or `model`", scope)
		}
		assertions = append(assertions, assertion)
	}
	return assertions, nil
}

func (s ArtifactStep) isAction() bool { return s.Kind == StepAction }
