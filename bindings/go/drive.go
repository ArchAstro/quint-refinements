package refinements

import (
	"fmt"
	"strings"
)

// ResolvedAction is one generated Quint action with arguments normalized
// through fixtures.
type ResolvedAction struct {
	// Name is the generated Quint action name.
	Name string
	// Arguments are evaluated against the current reduced state and fixtures.
	Arguments []RuntimeValue
}

// String renders the action in Rust's Debug notation, as divergence messages do.
func (a ResolvedAction) String() string {
	return fmt.Sprintf("ResolvedAction { name: %s, arguments: %s }", debugString(a.Name), debugValues(a.Arguments))
}

// FormatActions renders actions in Rust's Debug notation.
func FormatActions(actions []ResolvedAction) string {
	parts := make([]string, len(actions))
	for i, action := range actions {
		parts[i] = action.String()
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// PrimitiveDriver is the domain plug-in: run one implementation primitive and
// return one snapshot per refined step, in that order.
//
// Declare 1-to-N with Refines: [a, b, c] on the ownership record. The driver
// runs the impl command once and returns three evidences. Aliases are not a
// sequence.
type PrimitiveDriver interface {
	// RunPrimitive executes primitive once and returns one snapshot per resolved action.
	RunPrimitive(primitive string, actions []ResolvedAction) ([]Evidence, error)
}

// ActionDriver is the domain plug-in for a generated scenario whose boundary is
// dispatched one Quint action at a time.
//
// The returned evidence is a sparse observation of fields owned by that
// action. The runner merges it into Quint's assigned state before resolving
// or dispatching the next action.
type ActionDriver interface {
	// RunAction executes one resolved action and returns its observed implementation state.
	RunAction(action ResolvedAction) (Evidence, error)
}

// RefinementRun is the evidence tape and obligation count produced by a stepwise run.
type RefinementRun struct {
	// Snapshots is the initial evidence followed by one recorded snapshot per action.
	Snapshots []Evidence
	// Evaluated is the number of generated obligations evaluated during the run.
	Evaluated int
}

func boundRetrieve(retrieve []string, fixtures *FixtureTable) []string {
	return append(append([]string{}, retrieve...), fixtures.RetrieveNames()...)
}

// ResolveActionPlan resolves the generated action stream against the
// hydrated initial fixture.
//
// Drivers use this when a real boundary needs deterministic configuration from
// the scenario (for example, connection IDs) before dispatch begins.
func ResolveActionPlan(scenario *ArtifactScenario, init Evidence, fixtures *FixtureTable) ([]ResolvedAction, error) {
	bound := BindEvidence(fixtures, init)
	var actions []ResolvedAction
	for _, step := range actionSteps(scenario) {
		arguments, err := EvaluateActionArguments(step, bound)
		if err != nil {
			return nil, err
		}
		actions = append(actions, ResolvedAction{Name: step.Action, Arguments: arguments})
	}
	return actions, nil
}

// RefinementSession is a stateful reducer for runners whose live resources
// stay in a local harness.
//
// NextAction validates pre-guards and resolves arguments. Record merges the
// sparse observation and validates the post-state before another generated
// action can be requested.
type RefinementSession struct {
	scenario            *ArtifactScenario
	retrieve            []string
	fixtures            *FixtureTable
	steps               []ArtifactStep
	snapshots           []Evidence
	state               RuntimeValue
	nextIndex           int
	evaluated           int
	awaitingObservation bool
}

// NewRefinementSession starts a session from generated initial state and runtime evidence.
func NewRefinementSession(scenario *ArtifactScenario, init Evidence, retrieve []string, fixtures *FixtureTable) (*RefinementSession, error) {
	snapshots := []Evidence{init}
	state, err := projectedStateAfter(scenario, snapshots, retrieve, fixtures, 0)
	if err != nil {
		return nil, err
	}
	return &RefinementSession{
		scenario: scenario, retrieve: retrieve, fixtures: fixtures,
		steps: actionSteps(scenario), snapshots: snapshots, state: state,
	}, nil
}

// NextAction validates the current prefix and resolves the next action for
// dispatch. It returns nil when every generated action has been recorded.
func (s *RefinementSession) NextAction() (*ResolvedAction, error) {
	if s.awaitingObservation {
		return nil, errorf("record the preceding Rust action observation before requesting another action")
	}
	if s.nextIndex >= len(s.steps) {
		return nil, nil
	}
	snapshot := s.snapshots[len(s.snapshots)-1]
	if err := evaluateRunPreGuards(s.scenario, s.nextIndex, s.state, snapshot, s.retrieve, s.fixtures); err != nil {
		return nil, err
	}
	action, err := resolveAction(s.steps[s.nextIndex], s.state, snapshot, s.fixtures)
	if err != nil {
		return nil, err
	}
	s.awaitingObservation = true
	return &action, nil
}

// Record records sparse implementation evidence and reduces the generated next state.
func (s *RefinementSession) Record(evidence Evidence) error {
	if !s.awaitingObservation {
		return errorf("cannot record Rust evidence without a dispatched generated action")
	}
	s.snapshots = append(s.snapshots, evidence)
	step := s.steps[s.nextIndex]
	before := BindEvidence(s.fixtures, s.snapshots[s.nextIndex])
	after := BindEvidence(s.fixtures, s.snapshots[s.nextIndex+1])
	evaluated, state, err := evaluateProjectedActionStep(s.scenario.ID(), step.Action, step.Guards, step.Next, s.state, before, after, boundRetrieve(s.retrieve, s.fixtures))
	if err != nil {
		return err
	}
	s.evaluated += evaluated
	s.state = state
	s.nextIndex++
	s.awaitingObservation = false
	return nil
}

// Finish completes the session after every generated action has been recorded.
func (s *RefinementSession) Finish() (*RefinementRun, error) {
	if s.awaitingObservation {
		return nil, errorf("generated action was dispatched without a Rust observation")
	}
	if s.nextIndex != len(s.steps) {
		return nil, errorf("%s stopped after %d of %d generated actions", s.scenario.ID(), s.nextIndex, len(s.steps))
	}
	return &RefinementRun{Snapshots: s.snapshots, Evaluated: s.evaluated}, nil
}

// RunRefinedActions hydrates a fixture from Quint and dispatches the
// generated scenario one action at a time.
//
// Each action's pre-guards and arguments use the accumulated state from the
// preceding prefix. The action returns only its observed subset; Quint's
// assignment supplies the rest of the next state. Post-guards and `next` are
// evaluated before the following action is allowed to run.
func RunRefinedActions(scenario *ArtifactScenario, init Evidence, retrieve []string, fixtures *FixtureTable, driver ActionDriver) (*RefinementRun, error) {
	session, err := NewRefinementSession(scenario, init, retrieve, fixtures)
	if err != nil {
		return nil, err
	}
	for {
		action, err := session.NextAction()
		if err != nil {
			return nil, err
		}
		if action == nil {
			return session.Finish()
		}
		evidence, err := driver.RunAction(*action)
		if err != nil {
			return nil, err
		}
		if err := session.Record(evidence); err != nil {
			return nil, err
		}
	}
}

// RefineScenario walks the generated JSON through ownership records, runs each
// primitive once, and evaluates every guard/next conjunct on the resulting tape.
//
// fixtures owns Quint names (Idle, attemptA, universe sets). Snapshots own
// live `state`. Model-scope conjuncts are not skipped. It returns the number of
// obligations evaluated.
func RefineScenario(scenario *ArtifactScenario, init Evidence, ownership []OwnershipDescriptor, retrieve []string, fixtures *FixtureTable, driver PrimitiveDriver) (int, error) {
	runs, err := SchedulePrimitiveRuns(ScenarioActionNames(scenario), ownership)
	if err != nil {
		return 0, err
	}
	steps := actionSteps(scenario)
	snapshots := []Evidence{init}
	actionOffset := 0
	state, err := projectedStateAfter(scenario, snapshots, retrieve, fixtures, 0)
	if err != nil {
		return 0, err
	}
	for _, run := range runs {
		snapshot := snapshots[len(snapshots)-1]
		if err := evaluateRunPreGuards(scenario, actionOffset, state, snapshot, retrieve, fixtures); err != nil {
			return 0, err
		}
		actions, err := resolveRunActions(run, steps, actionOffset, state, snapshot, fixtures)
		if err != nil {
			return 0, err
		}
		tape, err := driver.RunPrimitive(run.Primitive, actions)
		if err != nil {
			return 0, err
		}
		if snapshots, err = extendValidatedTape(snapshots, run, tape); err != nil {
			return 0, err
		}
		actionOffset += len(run.OwnedActions)
		if state, err = projectedStateAfter(scenario, snapshots, retrieve, fixtures, actionOffset); err != nil {
			return 0, err
		}
	}
	return EvaluateRefinedTape(scenario, snapshots, retrieve, fixtures)
}

// actionArgumentEvidence adds the reduced state to argument evaluation.
type actionArgumentEvidence struct {
	state RuntimeValue
	bound Evidence
}

func (e actionArgumentEvidence) ResolveName(name string) (RuntimeValue, error) {
	if name == "state" {
		return e.state, nil
	}
	return e.bound.ResolveName(name)
}

func (e actionArgumentEvidence) ResolveCall(operator string, arguments []RuntimeValue) (RuntimeValue, bool, error) {
	return e.bound.ResolveCall(operator, arguments)
}

func resolveRunActions(run ScheduledPrimitiveRun, steps []ArtifactStep, actionOffset int, state RuntimeValue, snapshot Evidence, fixtures *FixtureTable) ([]ResolvedAction, error) {
	evidence := actionArgumentEvidence{state: state, bound: BindEvidence(fixtures, snapshot)}
	actions := make([]ResolvedAction, 0, len(run.OwnedActions))
	for index, expected := range run.OwnedActions {
		if actionOffset+index >= len(steps) {
			return nil, errorf("primitive %s has no generated action step", run.Primitive)
		}
		step := steps[actionOffset+index]
		if step.Action != expected {
			return nil, errorf("primitive %s expected generated action %s but found %s", run.Primitive, expected, step.Action)
		}
		arguments, err := EvaluateActionArguments(step, evidence)
		if err != nil {
			return nil, err
		}
		actions = append(actions, ResolvedAction{Name: step.Action, Arguments: arguments})
	}
	return actions, nil
}

func resolveAction(step ArtifactStep, state RuntimeValue, snapshot Evidence, fixtures *FixtureTable) (ResolvedAction, error) {
	if !step.isAction() {
		return ResolvedAction{}, errorf("cannot resolve a non-action scenario step")
	}
	evidence := actionArgumentEvidence{state: state, bound: BindEvidence(fixtures, snapshot)}
	arguments, err := EvaluateActionArguments(step, evidence)
	if err != nil {
		return ResolvedAction{}, err
	}
	return ResolvedAction{Name: step.Action, Arguments: arguments}, nil
}

func projectedStateAfter(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string, fixtures *FixtureTable, actionCount int) (RuntimeValue, error) {
	if scenario.InitialState == nil {
		return snapshots[len(snapshots)-1].ResolveName("state")
	}
	bound := make([]Evidence, len(snapshots))
	for i, snapshot := range snapshots {
		bound[i] = BindEvidence(fixtures, snapshot)
	}
	return evaluateProjectedPrefixState(scenario, bound, boundRetrieve(retrieve, fixtures), actionCount)
}

func evaluateRunPreGuards(scenario *ArtifactScenario, actionOffset int, state RuntimeValue, snapshot Evidence, retrieve []string, fixtures *FixtureTable) error {
	if scenario.InitialState == nil {
		return nil
	}
	_, err := evaluateProjectedPreGuards(scenario, actionOffset, state, BindEvidence(fixtures, snapshot), boundRetrieve(retrieve, fixtures))
	return err
}

// EvaluateRefinedTape binds fixtures in front of an already-collected snapshot
// tape and evaluates every guard and next conjunct.
func EvaluateRefinedTape(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string, fixtures *FixtureTable) (int, error) {
	bound := make([]Evidence, len(snapshots))
	for i, snapshot := range snapshots {
		bound[i] = BindEvidence(fixtures, snapshot)
	}
	if scenario.InitialState != nil {
		return EvaluateProjectedActionSteps(scenario, bound, boundRetrieve(retrieve, fixtures))
	}
	return EvaluateAllActionSteps(scenario, bound, boundRetrieve(retrieve, fixtures))
}

// EvaluateRefinedRuntimeAssertions binds fixtures and evaluates final
// observations against the state accumulated by EvaluateRefinedTape's
// Quint-owned reducer.
func EvaluateRefinedRuntimeAssertions(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string, fixtures *FixtureTable, supportedDependencies []string) (int, error) {
	bound := make([]Evidence, len(snapshots))
	for i, snapshot := range snapshots {
		bound[i] = BindEvidence(fixtures, snapshot)
	}
	return EvaluateProjectedRuntimeAssertions(scenario, bound, boundRetrieve(retrieve, fixtures), supportedDependencies)
}

// FormatStrings renders strings in Rust's Debug notation: ["a", "b"].
func FormatStrings(values []string) string { return debugStrings(values) }
