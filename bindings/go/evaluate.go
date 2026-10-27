package refinements

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Evidence resolves domain-specific names and calls used by refinement
// expressions.
//
// The shared evaluator owns the normalized expression grammar. Implementors
// expose only evidence that is specific to one runtime scenario family.
// Snapshots returned from an implementation must not change after they are
// returned: the runner keeps every one of them for the whole scenario.
type Evidence interface {
	// ResolveName resolves a generated name such as "state" to its observed value.
	ResolveName(name string) (RuntimeValue, error)
	// ResolveCall resolves an optional domain-specific call. It reports false
	// when it does not handle the operator, which falls through to the
	// built-in evaluation.
	ResolveCall(operator string, arguments []RuntimeValue) (RuntimeValue, bool, error)
}

// StateEvidence is the common Evidence: it answers only the name "state".
type StateEvidence struct{ State RuntimeValue }

// ResolveName returns State for "state" and fails for every other name.
func (e StateEvidence) ResolveName(name string) (RuntimeValue, error) {
	if name == "state" {
		return e.State, nil
	}
	return nil, errorf("unknown evidence name %s", name)
}

// ResolveCall never handles an operator.
func (StateEvidence) ResolveCall(string, []RuntimeValue) (RuntimeValue, bool, error) {
	return nil, false, nil
}

type assignmentSink struct{ value RuntimeValue }

type eval struct {
	current, before, after Evidence
	sink                   *assignmentSink
}

type environment map[string]RuntimeValue

func (env environment) with(name string, value RuntimeValue) environment {
	nested := make(environment, len(env)+1)
	for k, v := range env {
		nested[k] = v
	}
	nested[name] = value
	return nested
}

func allSame(e Evidence) eval { return eval{current: e, before: e, after: e} }

// EvaluateActionArguments resolves one generated action's Quint arguments
// against hydrated fixtures and the current scenario state.
func EvaluateActionArguments(step ArtifactStep, evidence Evidence) ([]RuntimeValue, error) {
	if !step.isAction() {
		return nil, errorf("only action steps have runtime arguments")
	}
	ev := allSame(evidence)
	values := make([]RuntimeValue, 0, len(step.Arguments))
	for _, argument := range step.Arguments {
		value, err := evaluateExpression(argument, ev, environment{})
		if err != nil {
			return nil, errorf("%s argument: %v", step.Action, err)
		}
		values = append(values, value)
	}
	return values, nil
}

// EvaluateRuntimeAssertions evaluates every non-model assertion in a checked
// scenario's observe steps.
//
// Evaluation fails closed when an assertion references a dependency outside
// the adapter's declared registry or uses unsupported normalized syntax.
func EvaluateRuntimeAssertions(scenario *ArtifactScenario, evidence Evidence, supportedDependencies []string) (int, error) {
	evaluated := 0
	for _, step := range scenario.Steps {
		if step.Kind != StepObserve {
			continue
		}
		count, err := evaluateAssertions(scenario.ID(), "observe", step.Assertions, allSame(evidence), supportedDependencies, true)
		if err != nil {
			return 0, err
		}
		evaluated += count
	}
	if evaluated == 0 {
		return 0, errorf("%s evaluated no runtime assertions", scenario.ID())
	}
	return evaluated, nil
}

// EvaluateStepObligations evaluates guard assertions on the retrieve-before
// snapshot and next-state assertions on the retrieve-after snapshot for one
// action step. Model-scope conjuncts are skipped. Prefer
// EvaluateAllStepObligations once the scenario's Quint names have fixture owners.
func EvaluateStepObligations(scenarioID, action string, guards, next []ArtifactAssertion, before, after Evidence, retrieve []string) (int, error) {
	return evaluateStepObligations(scenarioID, action, guards, next, before, after, retrieve, true)
}

// EvaluateAllStepObligations evaluates every guard and next conjunct, including model-scope.
func EvaluateAllStepObligations(scenarioID, action string, guards, next []ArtifactAssertion, before, after Evidence, retrieve []string) (int, error) {
	return evaluateStepObligations(scenarioID, action, guards, next, before, after, retrieve, false)
}

// EvaluateChapterNext evaluates each observe chapter's preceding action
// `next` against the same evidence used for that observe.
func EvaluateChapterNext(scenario *ArtifactScenario, evidence Evidence, retrieve []string) (int, error) {
	evaluated := 0
	for index, step := range scenario.Steps {
		if step.Kind == StepObserve {
			count, err := EvaluatePrecedingActionNext(scenario, index, evidence, retrieve)
			if err != nil {
				return 0, err
			}
			evaluated += count
		}
	}
	return evaluated, nil
}

// EvaluatePrecedingActionNext evaluates `next` on the last action before observeIndex.
func EvaluatePrecedingActionNext(scenario *ArtifactScenario, observeIndex int, evidence Evidence, retrieve []string) (int, error) {
	for i := observeIndex - 1; i >= 0; i-- {
		step := scenario.Steps[i]
		if !step.isAction() {
			continue
		}
		if len(step.Next) == 0 {
			return 0, nil
		}
		return EvaluateStepObligations(scenario.ID(), step.Action, nil, step.Next, evidence, evidence, retrieve)
	}
	return 0, nil
}

// EvaluateEveryActionStep is the strict fake-domain loop: snapshots[0] is
// retrieve-before the first action and snapshots[i+1] is retrieve-after
// action i. It fails if the snapshot count is not the action count plus one.
// Model-scope conjuncts are skipped.
func EvaluateEveryActionStep(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string) (int, error) {
	return evaluateActionSteps(scenario, snapshots, retrieve, true)
}

// EvaluateAllActionSteps is like EvaluateEveryActionStep, but every guard and
// next conjunct runs. Fixture-backed names belong on retrieve as "name:<fixture>".
func EvaluateAllActionSteps(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string) (int, error) {
	return evaluateActionSteps(scenario, snapshots, retrieve, false)
}

// EvaluateProjectedActionSteps evaluates a complete scenario as a reducer over
// its generated action tape.
//
// The generated Quint initial state is hydrated once into a RuntimeValue. Each
// generated action assignment advances that hydrated state; implementation
// evidence overlays only the state fields claimed by the retrieve contract.
// Pre-guards evaluate before the assignment and the implementation action,
// while assignment guards and every `next` conjunct evaluate against the merged
// state after it. The implementation therefore implements reusable actions, not
// handwritten scenarios or a second copy of Quint's state-transition logic.
func EvaluateProjectedActionSteps(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string) (int, error) {
	evaluated, _, err := evaluateProjectedActionStepsInner(scenario, snapshots, retrieve, true)
	return evaluated, err
}

// EvaluateProjectedRuntimeAssertions evaluates final scenario observations
// against the same accumulated state produced by the action reducer.
func EvaluateProjectedRuntimeAssertions(scenario *ArtifactScenario, snapshots []Evidence, retrieve, supportedDependencies []string) (int, error) {
	actionTotal := countActions(scenario)
	if len(snapshots) != actionTotal+1 {
		return 0, errorf("%s has %d actions but %d snapshots", scenario.ID(), actionTotal, len(snapshots))
	}
	actionCount := 0
	evaluated := 0
	for _, step := range scenario.Steps {
		switch step.Kind {
		case StepAction:
			actionCount++
		case StepObserve:
			state, err := evaluateProjectedPrefixState(scenario, snapshots[:actionCount+1], retrieve, actionCount)
			if err != nil {
				return 0, err
			}
			chapter := *scenario
			chapter.Steps = []ArtifactStep{step}
			count, err := EvaluateRuntimeAssertions(&chapter, projectedEvidence{snapshot: snapshots[actionCount], state: state}, supportedDependencies)
			if err != nil {
				return 0, err
			}
			evaluated += count
		}
	}
	if evaluated == 0 {
		return 0, errorf("%s evaluated no runtime assertions", scenario.ID())
	}
	return evaluated, nil
}

func countActions(scenario *ArtifactScenario) int {
	count := 0
	for _, step := range scenario.Steps {
		if step.isAction() {
			count++
		}
	}
	return count
}

func actionSteps(scenario *ArtifactScenario) []ArtifactStep {
	var steps []ArtifactStep
	for _, step := range scenario.Steps {
		if step.isAction() {
			steps = append(steps, step)
		}
	}
	return steps
}

func evaluateProjectedPrefixState(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string, actionCount int) (RuntimeValue, error) {
	prefix := *scenario
	prefix.Steps = nil
	retained := 0
	for _, step := range scenario.Steps {
		switch step.Kind {
		case StepInit:
			prefix.Steps = append(prefix.Steps, step)
		case StepAction:
			if retained < actionCount {
				retained++
				prefix.Steps = append(prefix.Steps, step)
			}
		}
	}
	_, state, err := evaluateProjectedActionStepsInner(&prefix, snapshots, retrieve, false)
	return state, err
}

func evaluateProjectedPreGuards(scenario *ArtifactScenario, actionIndex int, state RuntimeValue, snapshot Evidence, retrieve []string) (int, error) {
	steps := actionSteps(scenario)
	if actionIndex >= len(steps) {
		return 0, errorf("%s has no action %d", scenario.ID(), actionIndex)
	}
	step := steps[actionIndex]
	var preGuards []ArtifactAssertion
	for _, guard := range step.Guards {
		if !containsAssignment(guard.Expression) {
			preGuards = append(preGuards, guard)
		}
	}
	before := projectedEvidence{snapshot: snapshot, state: state}
	context := scenario.ID() + ":" + step.Action
	return evaluateAssertions(context, "pre-guard", preGuards, allSame(before), retrieve, false)
}

func evaluateProjectedActionStepsInner(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string, requireObligations bool) (int, RuntimeValue, error) {
	actions := actionSteps(scenario)
	if len(snapshots) != len(actions)+1 {
		return 0, nil, errorf("%s has %d actions but %d snapshots (want init plus one after each action)", scenario.ID(), len(actions), len(snapshots))
	}
	if scenario.InitialState == nil {
		return 0, nil, errorf("%s has no complete initial state", scenario.ID())
	}
	state, err := FromITFJSON(scenario.InitialState)
	if err != nil {
		return 0, nil, errorf("%s initial state: %v", scenario.ID(), err)
	}
	initialObserved, err := snapshots[0].ResolveName("state")
	if err != nil {
		return 0, nil, errorf("%s init state evidence: %v", scenario.ID(), err)
	}
	if !structurallyEqual(state, initialObserved) {
		difference, ok := structuralDifference(state, initialObserved, "state")
		if !ok {
			difference = "normalized values differ"
		}
		return 0, nil, errorf("%s Rust fixture does not match Quint initial state: %s", scenario.ID(), difference)
	}
	evaluated := 0
	for index, action := range actions {
		count, next, err := evaluateProjectedActionStep(scenario.ID(), action.Action, action.Guards, action.Next, state, snapshots[index], snapshots[index+1], retrieve)
		if err != nil {
			return 0, nil, err
		}
		evaluated += count
		state = next
	}
	if requireObligations && evaluated == 0 {
		return 0, nil, errorf("%s evaluated no action obligations", scenario.ID())
	}
	return evaluated, state, nil
}

func evaluateProjectedActionStep(scenarioID, action string, guards, next []ArtifactAssertion, state RuntimeValue, beforeSnapshot, afterSnapshot Evidence, retrieve []string) (int, RuntimeValue, error) {
	context := scenarioID + ":" + action
	before := projectedEvidence{snapshot: beforeSnapshot, state: state}
	var preGuards, postGuards []ArtifactAssertion
	for _, guard := range guards {
		if containsAssignment(guard.Expression) {
			postGuards = append(postGuards, guard)
		} else {
			preGuards = append(preGuards, guard)
		}
	}
	evaluated, err := evaluateAssertions(context, "pre-guard", preGuards, allSame(before), retrieve, false)
	if err != nil {
		return 0, nil, err
	}

	sink := &assignmentSink{}
	captureEval := eval{current: before, before: before, after: before, sink: sink}
	var assignmentKind string
	var assignment *ArtifactAssertion
	for i := range guards {
		if containsAssignment(guards[i].Expression) {
			assignmentKind, assignment = "post-guard", &guards[i]
			break
		}
	}
	if assignment == nil {
		for i := range next {
			if containsAssignment(next[i].Expression) {
				assignmentKind, assignment = "next", &next[i]
				break
			}
		}
	}
	if assignment == nil {
		return 0, nil, errorf("%s next: complete action has no state assignment", context)
	}
	if _, err := evaluateAssertions(context, assignmentKind, []ArtifactAssertion{*assignment}, captureEval, retrieve, false); err != nil {
		return 0, nil, err
	}
	if sink.value == nil {
		return 0, nil, errorf("%s next: complete action has no state assignment", context)
	}
	modelNext := sink.value
	observed, err := afterSnapshot.ResolveName("state")
	if err != nil {
		return 0, nil, errorf("%s state evidence: %v", context, err)
	}
	observedFields := map[string]bool{}
	for _, assertion := range append(append([]ArtifactAssertion{}, guards...), next...) {
		if assertion.Scope != ScopeRuntime {
			continue
		}
		for _, dependency := range assertion.Dependencies {
			if path, ok := strings.CutPrefix(dependency, "path:state."); ok {
				field, _, _ := strings.Cut(path, ".")
				observedFields[field] = true
			}
		}
	}
	if err := requireChangedObservations(state, modelNext, observed, observedFields); err != nil {
		return 0, nil, errorf("%s state evidence: %v", context, err)
	}
	mergedFields := observedStateFields(retrieve)
	for field := range observedFields {
		mergedFields[field] = true
	}
	merged, err := mergeObservedState(modelNext, observed, mergedFields)
	if err != nil {
		return 0, nil, err
	}
	after := projectedEvidence{snapshot: afterSnapshot, state: merged}
	postGuardEval := eval{current: before, before: before, after: after}
	count, err := evaluateAssertions(context, "post-guard", postGuards, postGuardEval, retrieve, false)
	if err != nil {
		return 0, nil, err
	}
	evaluated += count
	nextEval := eval{current: after, before: before, after: after}
	count, err = evaluateAssertions(context, "next", next, nextEval, retrieve, false)
	if err != nil {
		return 0, nil, err
	}
	evaluated += count
	return evaluated, merged, nil
}

type projectedEvidence struct {
	snapshot Evidence
	state    RuntimeValue
}

func (e projectedEvidence) ResolveName(name string) (RuntimeValue, error) {
	if name == "state" {
		return e.state, nil
	}
	return e.snapshot.ResolveName(name)
}

func (e projectedEvidence) ResolveCall(operator string, arguments []RuntimeValue) (RuntimeValue, bool, error) {
	if operator == "dedupEntry" && len(arguments) == 1 {
		value, err := projectedOptionalMapValue(e.state, "connector_dedup", arguments[0])
		return value, true, err
	}
	if operator == "dedupValue" && len(arguments) == 1 {
		value, err := projectedOptionalMapValue(e.state, "connector_dedup", arguments[0])
		if err != nil {
			return nil, true, err
		}
		switch value := value.(type) {
		case Present:
			return value.Value, true, nil
		case Absent:
			return nil, true, errorf("projected connector_dedup entry is absent")
		default:
			return value, true, nil
		}
	}
	if delivery, ok := firstRecord(operator == "resultFor" && len(arguments) == 2, arguments); ok {
		field := func(name string) (RuntimeValue, error) {
			value, ok := delivery[name]
			if !ok {
				return nil, errorf("deliveryValue has no %s", name)
			}
			return value, nil
		}
		result := Record{}
		for _, pair := range [][2]string{
			{"attempt_id", "attempt_id"}, {"delivery_id", "id"}, {"org_id", "org_id"},
			{"service_spec_id", "service_spec_id"}, {"service_id", "service_id"}, {"connection_id", "connection_id"},
		} {
			value, err := field(pair[1])
			if err != nil {
				return nil, true, err
			}
			result[pair[0]] = value
		}
		result["outcome"] = arguments[1]
		return result, true, nil
	}
	collection := ""
	switch operator {
	case "attemptValue":
		collection = "attempts"
	case "connectionValue":
		collection = "connections"
	case "deliveryValue":
		collection = "deliveries"
	case "tokenValue":
		collection = "enrollment_tokens"
	}
	if collection != "" && len(arguments) == 1 {
		value, err := projectedMapValue(e.state, collection, arguments[0])
		return value, true, err
	}
	return e.snapshot.ResolveCall(operator, arguments)
}

func firstRecord(matches bool, arguments []RuntimeValue) (Record, bool) {
	if !matches {
		return nil, false
	}
	record, ok := arguments[0].(Record)
	return record, ok
}

func projectedOptionalMapValue(state RuntimeValue, field string, key RuntimeValue) (RuntimeValue, error) {
	record, ok := state.(Record)
	if !ok {
		return nil, errorf("projected state is not a record")
	}
	values, ok := record[field].(Map)
	if !ok {
		return nil, errorf("projected state has no map %s", field)
	}
	if value, found := values.Get(key); found {
		return value, nil
	}
	return Absent{}, nil
}

func projectedMapValue(state RuntimeValue, field string, key RuntimeValue) (RuntimeValue, error) {
	record, ok := state.(Record)
	if !ok {
		return nil, errorf("projected state is not a record")
	}
	var value RuntimeValue
	switch collection := record[field].(type) {
	case Map:
		value, _ = collection.Get(key)
	case Record:
		text, isText := key.(Text)
		if !isText {
			return nil, errorf("projected state has no keyed collection %s", field)
		}
		value = collection[string(text)]
	default:
		return nil, errorf("projected state has no keyed collection %s", field)
	}
	switch value := value.(type) {
	case Present:
		return value.Value, nil
	case Absent, nil:
		return nil, errorf("projected %s has no value for %s", field, key)
	default:
		return value, nil
	}
}

func observedStateFields(retrieve []string) map[string]bool {
	fields := map[string]bool{}
	for _, dependency := range retrieve {
		if path, ok := strings.CutPrefix(dependency, "path:state."); ok {
			field, _, _ := strings.Cut(path, ".")
			fields[field] = true
		}
	}
	return fields
}

func sortedFields(fields map[string]bool) []string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func containsAssignment(expression any) bool {
	if kind, _ := jsonKind(expression); kind == "call" {
		if operator, _ := jsonField(expression, "operator").(string); operator == "assign" {
			return true
		}
	}
	switch expression := expression.(type) {
	case []any:
		for _, value := range expression {
			if containsAssignment(value) {
				return true
			}
		}
	case map[string]any:
		for _, value := range expression {
			if containsAssignment(value) {
				return true
			}
		}
	}
	return false
}

func mergeObservedState(model, observed RuntimeValue, fields map[string]bool) (RuntimeValue, error) {
	modelFields, ok := model.(Record)
	if !ok {
		return nil, errorf("generated Quint state is not a record")
	}
	observedFields, ok := observed.(Record)
	if !ok {
		return nil, errorf("Rust action state evidence is not a record")
	}
	merged := make(Record, len(modelFields))
	for key, value := range modelFields {
		merged[key] = value
	}
	for _, field := range sortedFields(fields) {
		value, ok := observedFields[field]
		if !ok {
			continue
		}
		modelValue, ok := merged[field]
		if !ok {
			return nil, errorf("Rust action evidence contains field state.%s outside the hydrated Quint state", field)
		}
		merged[field] = mergeStateValue(modelValue, value)
	}
	return merged, nil
}

func requireChangedObservations(before, modelNext, observed RuntimeValue, fields map[string]bool) error {
	beforeRecord, beforeOK := before.(Record)
	nextRecord, nextOK := modelNext.(Record)
	if !beforeOK || !nextOK {
		return errorf("generated Quint state is not a record")
	}
	observedRecord, ok := observed.(Record)
	if !ok {
		return errorf("Rust action state evidence is not a record")
	}
	for _, field := range sortedFields(fields) {
		left, leftOK := beforeRecord[field]
		right, rightOK := nextRecord[field]
		changed := leftOK != rightOK || (leftOK && !Equal(left, right))
		if _, observedField := observedRecord[field]; changed && !observedField {
			return errorf("Rust action omitted changed runtime-owned field state.%s", field)
		}
	}
	return nil
}

// mergeStateValue overlays update onto accumulated without modifying either.
func mergeStateValue(accumulated, update RuntimeValue) RuntimeValue {
	switch acc := accumulated.(type) {
	case Map:
		switch upd := update.(type) {
		case Map:
			result := acc
			for _, entry := range upd.entries {
				if existing, ok := result.Get(entry.Key); ok {
					result = result.with(entry.Key, mergeStateValue(existing, entry.Value))
				} else {
					result = result.with(entry.Key, entry.Value)
				}
			}
			return result
		case Record:
			result := acc
			for _, key := range upd.sortedKeys() {
				mapKey := Text(key)
				if existing, ok := result.Get(mapKey); ok {
					result = result.with(mapKey, mergeStateValue(existing, upd[key]))
				} else {
					result = result.with(mapKey, upd[key])
				}
			}
			return result
		}
	case Record:
		if upd, ok := update.(Record); ok {
			result := make(Record, len(acc))
			for key, value := range acc {
				result[key] = value
			}
			for key, value := range upd {
				if existing, ok := result[key]; ok {
					result[key] = mergeStateValue(existing, value)
				} else {
					result[key] = value
				}
			}
			return result
		}
	case List:
		if upd, ok := update.(List); ok && len(acc) == len(upd) {
			return List(mergeElements(acc, upd))
		}
	case Tuple:
		if upd, ok := update.(Tuple); ok && len(acc) == len(upd) {
			return Tuple(mergeElements(acc, upd))
		}
	case Variant:
		if upd, ok := update.(Variant); ok && acc.Tag == upd.Tag {
			return Variant{Tag: acc.Tag, Value: mergeStateValue(acc.Value, upd.Value)}
		}
	case Present:
		if upd, ok := update.(Present); ok {
			return Present{Value: mergeStateValue(acc.Value, upd.Value)}
		}
	}
	return update
}

func mergeElements(accumulated, update []RuntimeValue) []RuntimeValue {
	merged := make([]RuntimeValue, len(accumulated))
	for i := range accumulated {
		merged[i] = mergeStateValue(accumulated[i], update[i])
	}
	return merged
}

func evaluateActionSteps(scenario *ArtifactScenario, snapshots []Evidence, retrieve []string, skipModel bool) (int, error) {
	actions := actionSteps(scenario)
	if len(snapshots) != len(actions)+1 {
		return 0, errorf("%s has %d actions but %d snapshots (want init plus one after each action)", scenario.ID(), len(actions), len(snapshots))
	}
	evaluated := 0
	for index, step := range actions {
		count, err := evaluateStepObligations(scenario.ID(), step.Action, step.Guards, step.Next, snapshots[index], snapshots[index+1], retrieve, skipModel)
		if err != nil {
			return 0, err
		}
		evaluated += count
	}
	return evaluated, nil
}

func evaluateStepObligations(scenarioID, action string, guards, next []ArtifactAssertion, before, after Evidence, retrieve []string, skipModel bool) (int, error) {
	if len(guards) == 0 && len(next) == 0 {
		return 0, nil
	}
	context := scenarioID + ":" + action
	evaluated, err := evaluateAssertions(context, "guard", guards, eval{current: before, before: before, after: after}, retrieve, skipModel)
	if err != nil {
		return 0, err
	}
	count, err := evaluateAssertions(context, "next", next, eval{current: after, before: before, after: after}, retrieve, skipModel)
	if err != nil {
		return 0, err
	}
	evaluated += count
	if evaluated == 0 {
		return 0, errorf("%s declared step obligations but evaluated none", context)
	}
	return evaluated, nil
}

func evaluateAssertions(context, kind string, assertions []ArtifactAssertion, ev eval, supported []string, skipModel bool) (int, error) {
	evaluated := 0
	for _, assertion := range assertions {
		if skipModel && assertion.Scope == ScopeModel {
			continue
		}
		for _, dependency := range assertion.Dependencies {
			if !dependencyIsSupported(dependency, supported) {
				return 0, errorf("%s %s uses unsupported runtime dependency %s", context, kind, dependency)
			}
		}
		value, err := evaluateExpression(assertion.Expression, ev, environment{})
		if err != nil {
			return 0, errorf("%s %s: %v", context, kind, err)
		}
		boolean, ok := value.(Bool)
		switch {
		case ok && bool(boolean):
			evaluated++
		case ok:
			return 0, errorf("%s assertion evaluated false in %s: %s", kind, context, jsonString(assertion.Expression))
		default:
			return 0, errorf("%s assertion did not evaluate to boolean in %s: %s", kind, context, jsonString(assertion.Expression))
		}
	}
	return evaluated, nil
}

func dependencyIsSupported(dependency string, supported []string) bool {
	switch dependency {
	case "operator:eq", "operator:neq", "operator:not", "operator:actionAll", "operator:contains",
		"operator:field", "operator:get", "operator:assign":
		return true
	}
	for _, candidate := range supported {
		if candidate == dependency {
			return true
		}
	}
	return false
}

func evaluateExpression(expression any, ev eval, env environment) (RuntimeValue, error) {
	kind, _ := jsonKind(expression)
	switch kind {
	case "bool":
		value, ok := jsonField(expression, "value").(bool)
		if !ok {
			return nil, errorf("normalized boolean has no value")
		}
		return Bool(value), nil
	case "int":
		number, ok := asInt64(jsonField(expression, "value"))
		if !ok {
			return nil, errorf("normalized integer has no value")
		}
		return Int(number), nil
	case "str":
		value, ok := jsonField(expression, "value").(string)
		if !ok {
			return nil, errorf("normalized string has no value")
		}
		return Text(value), nil
	case "name":
		name, ok := jsonField(expression, "value").(string)
		if !ok {
			return nil, errorf("normalized name has no value")
		}
		if value, found := env[name]; found {
			return value, nil
		}
		switch name {
		case "disabled":
			return Bool(false), nil
		case "Absent":
			if value, err := ev.current.ResolveName(name); err == nil {
				return value, nil
			}
			return Absent{}, nil
		}
		return ev.current.ResolveName(name)
	case "call":
		return evaluateCall(expression, ev, env)
	case "let":
		return evaluateLet(expression, ev, env)
	}
	return nil, errorf("unsupported normalized expression kind")
}

func asInt64(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	return parsed, err == nil
}

func evaluateLet(expression any, ev eval, env environment) (RuntimeValue, error) {
	name, ok := jsonField(expression, "name").(string)
	if !ok {
		return nil, errorf("normalized let has no name")
	}
	value, err := evaluateExpression(jsonField(expression, "value"), ev, env)
	if err != nil {
		return nil, err
	}
	return evaluateExpression(jsonField(expression, "body"), ev, env.with(name, value))
}

func evaluateCall(expression any, ev eval, env environment) (RuntimeValue, error) {
	operator, ok := jsonField(expression, "operator").(string)
	if !ok {
		return nil, errorf("normalized call has no operator")
	}
	arguments, ok := jsonField(expression, "arguments").([]any)
	if !ok {
		return nil, errorf("normalized call has no arguments")
	}
	switch operator {
	case "assign":
		return evaluateAssign(arguments, ev, env)
	case "matchVariant":
		return evaluateMatchVariant(arguments, ev, env)
	case "filter":
		return evaluateFilter(arguments, ev, env)
	case "map", "mapBy":
		return evaluateMap(operator, arguments, ev, env)
	case "fold":
		return evaluateFold(arguments, ev, env)
	case "forall", "exists":
		return evaluateQuantifier(operator, arguments, ev, env)
	case "ite":
		return evaluateIte(arguments, ev, env)
	case "and", "or", "actionAll", "actionAny":
		return evaluateShortCircuit(operator, arguments, ev, env)
	}
	values := make([]RuntimeValue, 0, len(arguments))
	for _, argument := range arguments {
		value, err := evaluateExpression(argument, ev, env)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if result, handled, err := commonCall(operator, values); handled {
		return result, err
	}
	if result, handled, err := ev.current.ResolveCall(operator, values); handled {
		return result, err
	}
	if first, _ := utf8.DecodeRuneInString(operator); unicode.IsUpper(first) {
		if len(values) != 1 {
			return nil, errorf("variant constructor %s requires one value, received %d", operator, len(values))
		}
		return Variant{Tag: operator, Value: values[0]}, nil
	}
	return nil, errorf("unsupported runtime operator %s for %s", operator, debugValues(values))
}

func evaluateAssign(arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) != 2 {
		return nil, errorf("assign requires a variable and an expression")
	}
	left, right := arguments[0], arguments[1]
	expected, err := evaluateExpression(right, eval{current: ev.before, before: ev.before, after: ev.after, sink: ev.sink}, env)
	if err != nil {
		return nil, err
	}
	if ev.sink != nil {
		ev.sink.value = expected
		return Bool(true), nil
	}
	observed, err := evaluateExpression(left, eval{current: ev.after, before: ev.before, after: ev.after, sink: ev.sink}, env)
	if err != nil {
		return nil, err
	}
	if structurallyEqual(expected, observed) {
		return Bool(true), nil
	}
	difference, ok := structuralDifference(expected, observed, "state")
	if !ok {
		difference = "state"
	}
	return nil, errorf("assign state diverged at %s", difference)
}

func overflow(operator string) error {
	return errorf("integer overflow in %s: the result is outside the normalized i64 range", operator)
}

// commonCall evaluates the built-in operators. The boolean reports whether the
// operator and argument shapes matched; if not, the caller consults the
// evidence's own calls.
func commonCall(operator string, values []RuntimeValue) (RuntimeValue, bool, error) {
	ok := func(value RuntimeValue) (RuntimeValue, bool, error) { return value, true, nil }
	switch operator {
	case "eq":
		if len(values) == 2 {
			return ok(Bool(Equal(values[0], values[1])))
		}
	case "neq":
		if len(values) == 2 {
			return ok(Bool(!Equal(values[0], values[1])))
		}
	case "not":
		if len(values) == 1 {
			if value, isBool := values[0].(Bool); isBool {
				return ok(Bool(!bool(value)))
			}
		}
	case "Present":
		if len(values) == 1 {
			return ok(Present{Value: values[0]})
		}
	case "variant":
		if len(values) == 2 {
			if tag, isText := values[0].(Text); isText {
				return ok(Variant{Tag: string(tag), Value: values[1]})
			}
		}
	case "List":
		return ok(List(append([]RuntimeValue{}, values...)))
	case "Tup":
		return ok(Tuple(append([]RuntimeValue{}, values...)))
	case "Set":
		return ok(NewSet(values...))
	case "Map":
		result, err := mapFromValues(values)
		return result, true, err
	case "Rec":
		result, err := recordFromValues(values)
		return result, true, err
	case "replicaPoolKey":
		if len(values) == 2 {
			replica, replicaOK := values[0].(Text)
			poolKey, poolOK := values[1].(Record)
			if replicaOK && poolOK {
				return ok(Record{"replica_id": replica, "pool_key": poolKey})
			}
		}
	case "field":
		if len(values) == 2 {
			fields, recordOK := values[0].(Record)
			key, keyOK := values[1].(Text)
			if recordOK && keyOK {
				value, found := fields[string(key)]
				if !found {
					return nil, true, errorf("runtime record has no field %s", string(key))
				}
				return ok(value)
			}
		}
	case "get":
		if len(values) == 2 {
			if fields, recordOK := values[0].(Record); recordOK {
				if key, keyOK := values[1].(Text); keyOK {
					if value, found := fields[string(key)]; found {
						return ok(value)
					}
					return ok(Absent{})
				}
			}
			if entries, mapOK := values[0].(Map); mapOK {
				value, found := entries.Get(values[1])
				if !found {
					return nil, true, errorf("map has no key %s", values[1])
				}
				return ok(value)
			}
		}
	case "contains":
		if len(values) == 2 {
			if set, setOK := values[0].(Set); setOK {
				return ok(Bool(set.Contains(values[1])))
			}
		}
	case "length":
		if len(values) == 1 {
			if list, listOK := values[0].(List); listOK {
				return ok(Int(len(list)))
			}
		}
	case "size":
		if len(values) == 1 {
			switch collection := values[0].(type) {
			case List:
				return ok(Int(len(collection)))
			case Tuple:
				return ok(Int(len(collection)))
			case Set:
				return ok(Int(collection.Len()))
			case Map:
				return ok(Int(collection.Len()))
			case Record:
				return ok(Int(len(collection)))
			}
		}
	case "with":
		if len(values) == 3 {
			fields, recordOK := values[0].(Record)
			key, keyOK := values[1].(Text)
			if recordOK && keyOK {
				return ok(fields.with(string(key), values[2]))
			}
		}
	case "set":
		if len(values) == 3 {
			if fields, recordOK := values[0].(Record); recordOK {
				if key, keyOK := values[1].(Text); keyOK {
					return ok(fields.with(string(key), values[2]))
				}
			}
			if entries, mapOK := values[0].(Map); mapOK {
				if _, found := entries.Get(values[1]); !found {
					return nil, true, errorf("set cannot add missing map key %s", values[1])
				}
				return ok(entries.with(values[1], values[2]))
			}
		}
	case "put":
		if len(values) == 3 {
			if entries, mapOK := values[0].(Map); mapOK {
				return ok(entries.with(values[1], values[2]))
			}
		}
	case "union":
		if len(values) == 2 {
			left, leftOK := values[0].(Set)
			right, rightOK := values[1].(Set)
			if leftOK && rightOK {
				return ok(NewSet(append(append([]RuntimeValue{}, left.members...), right.members...)...))
			}
		}
	case "exclude":
		if len(values) == 2 {
			left, leftOK := values[0].(Set)
			right, rightOK := values[1].(Set)
			if leftOK && rightOK {
				kept := []RuntimeValue{}
				for _, member := range left.members {
					if !right.Contains(member) {
						kept = append(kept, member)
					}
				}
				return ok(Set{members: kept})
			}
		}
	case "ilt", "igt", "ilte", "igte", "iadd", "isub":
		if len(values) == 2 {
			left, leftOK := values[0].(Int)
			right, rightOK := values[1].(Int)
			if !leftOK || !rightOK {
				break
			}
			switch operator {
			case "ilt":
				return ok(Bool(left < right))
			case "igt":
				return ok(Bool(left > right))
			case "ilte":
				return ok(Bool(left <= right))
			case "igte":
				return ok(Bool(left >= right))
			case "iadd":
				sum := left + right
				if (right > 0 && sum < left) || (right < 0 && sum > left) {
					return nil, true, overflow(operator)
				}
				return ok(sum)
			case "isub":
				difference := left - right
				if (right > 0 && difference > left) || (right < 0 && difference < left) {
					return nil, true, overflow(operator)
				}
				return ok(difference)
			}
		}
	case "append":
		if len(values) == 2 {
			if list, listOK := values[0].(List); listOK {
				return ok(append(append(List{}, list...), values[1]))
			}
		}
	case "concat":
		if len(values) == 2 {
			left, leftOK := values[0].(List)
			right, rightOK := values[1].(List)
			if leftOK && rightOK {
				return ok(append(append(List{}, left...), right...))
			}
		}
	case "indices":
		if len(values) == 1 {
			if list, listOK := values[0].(List); listOK {
				members := make([]RuntimeValue, len(list))
				for i := range list {
					members[i] = Int(i)
				}
				return ok(Set{members: members})
			}
		}
	case "nth":
		if len(values) == 2 {
			list, listOK := values[0].(List)
			index, indexOK := values[1].(Int)
			if listOK && indexOK {
				if index < 0 || int64(index) >= int64(len(list)) {
					return nil, true, errorf("list index %d is out of bounds", int64(index))
				}
				return ok(list[index])
			}
		}
	case "keys":
		if len(values) == 1 {
			if entries, mapOK := values[0].(Map); mapOK {
				members := make([]RuntimeValue, len(entries.entries))
				for i, entry := range entries.entries {
					members[i] = entry.Key
				}
				return ok(Set{members: members})
			}
		}
	}
	return nil, false, nil
}

func recordFromValues(values []RuntimeValue) (RuntimeValue, error) {
	if len(values)%2 != 0 {
		return nil, errorf("Rec requires key and value pairs")
	}
	fields := Record{}
	for i := 0; i < len(values); i += 2 {
		key, ok := values[i].(Text)
		if !ok {
			return nil, errorf("Rec key is not text")
		}
		fields[string(key)] = values[i+1]
	}
	return fields, nil
}

func mapFromValues(values []RuntimeValue) (RuntimeValue, error) {
	entries := make([]MapEntry, 0, len(values))
	for _, value := range values {
		pair, ok := value.(Tuple)
		if !ok {
			return nil, errorf("Map accepts only key/value tuples")
		}
		if len(pair) != 2 {
			return nil, errorf("Map entries must contain exactly two values")
		}
		entries = append(entries, MapEntry{Key: pair[0], Value: pair[1]})
	}
	return NewMap(entries...), nil
}

func structurallyEqual(expected, observed RuntimeValue) bool {
	_, differs := structuralDifference(expected, observed, "state")
	return !differs
}

// structuralDifference names the first place two values diverge, or reports
// false when they are equal. Messages match the Rust binding's.
func structuralDifference(expected, observed RuntimeValue, path string) (string, bool) {
	switch exp := expected.(type) {
	case Record:
		if obs, ok := observed.(Record); ok {
			if len(exp) != len(obs) {
				var missing, unexpected []string
				for _, key := range exp.sortedKeys() {
					if _, found := obs[key]; !found {
						missing = append(missing, key)
					}
				}
				for _, key := range obs.sortedKeys() {
					if _, found := exp[key]; !found {
						unexpected = append(unexpected, key)
					}
				}
				return fmt.Sprintf("%s record fields differ; missing %s, unexpected %s", path, debugStrings(missing), debugStrings(unexpected)), true
			}
			for _, key := range exp.sortedKeys() {
				nested := path + "." + key
				observedValue, found := obs[key]
				if !found {
					return nested + " missing from observed state", true
				}
				if difference, differs := structuralDifference(exp[key], observedValue, nested); differs {
					return difference, true
				}
			}
			return "", false
		}
	case Present:
		if obs, ok := observed.(Present); ok {
			return structuralDifference(exp.Value, obs.Value, path)
		}
	case List:
		if obs, ok := observed.(List); ok {
			if len(exp) != len(obs) {
				return fmt.Sprintf("%s expected list length %d, observed %d", path, len(exp), len(obs)), true
			}
			for i := range exp {
				if difference, differs := structuralDifference(exp[i], obs[i], fmt.Sprintf("%s[%d]", path, i)); differs {
					return difference, true
				}
			}
			return "", false
		}
	case Map:
		if obs, ok := observed.(Map); ok {
			keyPath := func(key RuntimeValue) string {
				switch key := key.(type) {
				case Text:
					return fmt.Sprintf("%s[%s]", path, debugString(string(key)))
				case Int:
					return fmt.Sprintf("%s[%d]", path, int64(key))
				}
				return fmt.Sprintf("%s[%s]", path, key)
			}
			for _, entry := range exp.entries {
				if _, found := obs.Get(entry.Key); !found {
					return keyPath(entry.Key) + " missing from observed state", true
				}
			}
			for _, entry := range obs.entries {
				if _, found := exp.Get(entry.Key); !found {
					return keyPath(entry.Key) + " unexpected in observed state", true
				}
			}
			for _, entry := range exp.entries {
				observedValue, _ := obs.Get(entry.Key)
				if difference, differs := structuralDifference(entry.Value, observedValue, keyPath(entry.Key)); differs {
					return difference, true
				}
			}
			return "", false
		}
	}
	if Equal(expected, observed) {
		return "", false
	}
	return fmt.Sprintf("%s expected %s, observed %s", path, expected, observed), true
}

// Quint's `and` and `or` stop at the first argument that decides the result,
// so a later argument may rely on an earlier one, as in
// `l.length() > i and l[i] == x`.
func evaluateShortCircuit(operator string, arguments []any, ev eval, env environment) (RuntimeValue, error) {
	decisive := operator == "or" || operator == "actionAny"
	for _, argument := range arguments {
		value, err := evaluateExpression(argument, ev, env)
		if err != nil {
			return nil, err
		}
		boolean, ok := value.(Bool)
		if !ok {
			return nil, errorf("%s accepts only normalized booleans", operator)
		}
		if bool(boolean) == decisive {
			return Bool(decisive), nil
		}
	}
	return Bool(!decisive), nil
}

func evaluateIte(arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) != 3 {
		return nil, errorf("ite requires a condition and two branches")
	}
	condition, err := evaluateExpression(arguments[0], ev, env)
	if err != nil {
		return nil, err
	}
	boolean, ok := condition.(Bool)
	if !ok {
		return nil, errorf("ite condition is not boolean")
	}
	if boolean {
		return evaluateExpression(arguments[1], ev, env)
	}
	return evaluateExpression(arguments[2], ev, env)
}

func isLambda(value any) bool {
	kind, _ := jsonKind(value)
	return kind == "lambda"
}

func firstParameter(lambda any) (string, bool) {
	parameters, ok := jsonField(lambda, "parameters").([]any)
	if !ok || len(parameters) == 0 {
		return "", false
	}
	name, ok := parameters[0].(string)
	return name, ok
}

func evaluateQuantifier(operator string, arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) != 2 {
		return nil, errorf("%s requires a collection and one lambda", operator)
	}
	collection, err := evaluateExpression(arguments[0], ev, env)
	if err != nil {
		return nil, err
	}
	var items []RuntimeValue
	switch collection := collection.(type) {
	case Set:
		items = collection.members
	case List:
		items = collection
	case Tuple:
		items = collection
	case Map:
		for _, entry := range collection.entries {
			items = append(items, entry.Value)
		}
	case Record:
		for _, key := range collection.sortedKeys() {
			items = append(items, collection[key])
		}
	default:
		return nil, errorf("%s input is not a collection", operator)
	}
	lambda := arguments[1]
	if !isLambda(lambda) {
		return nil, errorf("%s predicate is not a lambda", operator)
	}
	parameter, ok := firstParameter(lambda)
	if !ok {
		return nil, errorf("%s lambda has no parameter", operator)
	}
	body := jsonField(lambda, "body")
	all, any := true, false
	for _, item := range items {
		value, err := evaluateExpression(body, ev, env.with(parameter, item))
		if err != nil {
			return nil, err
		}
		boolean, isBool := value.(Bool)
		if !isBool {
			return nil, errorf("%s predicate did not evaluate to boolean", operator)
		}
		all = all && bool(boolean)
		any = any || bool(boolean)
	}
	if operator == "forall" {
		return Bool(all), nil
	}
	return Bool(any), nil
}

func evaluateFilter(arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) != 2 {
		return nil, errorf("filter requires a list and one lambda")
	}
	collection, err := evaluateExpression(arguments[0], ev, env)
	if err != nil {
		return nil, err
	}
	var items []RuntimeValue
	isSet := false
	switch collection := collection.(type) {
	case List:
		items = collection
	case Set:
		items, isSet = collection.members, true
	default:
		return nil, errorf("filter input is not a list or set")
	}
	filtered := []RuntimeValue{}
	for _, item := range items {
		value, err := evaluateLambda(arguments[1], []RuntimeValue{item}, ev, env)
		if err != nil {
			return nil, err
		}
		boolean, ok := value.(Bool)
		if !ok {
			return nil, errorf("filter predicate did not evaluate to boolean")
		}
		if boolean {
			filtered = append(filtered, item)
		}
	}
	if isSet {
		return Set{members: filtered}, nil
	}
	return List(filtered), nil
}

func evaluateMap(operator string, arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) != 2 {
		return nil, errorf("%s requires a set and one lambda", operator)
	}
	collection, err := evaluateExpression(arguments[0], ev, env)
	if err != nil {
		return nil, err
	}
	set, ok := collection.(Set)
	if !ok {
		return nil, errorf("%s input is not a set", operator)
	}
	if operator == "map" {
		mapped := make([]RuntimeValue, 0, set.Len())
		for _, member := range set.members {
			value, err := evaluateLambda(arguments[1], []RuntimeValue{member}, ev, env)
			if err != nil {
				return nil, err
			}
			mapped = append(mapped, value)
		}
		return NewSet(mapped...), nil
	}
	entries := make([]MapEntry, 0, set.Len())
	for _, key := range set.members {
		value, err := evaluateLambda(arguments[1], []RuntimeValue{key}, ev, env)
		if err != nil {
			return nil, err
		}
		entries = append(entries, MapEntry{Key: key, Value: value})
	}
	return NewMap(entries...), nil
}

func evaluateFold(arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) != 3 {
		return nil, errorf("fold requires a set, initial value, and lambda")
	}
	collection, err := evaluateExpression(arguments[0], ev, env)
	if err != nil {
		return nil, err
	}
	set, ok := collection.(Set)
	if !ok {
		return nil, errorf("fold input is not a set")
	}
	accumulator, err := evaluateExpression(arguments[1], ev, env)
	if err != nil {
		return nil, err
	}
	for _, member := range set.members {
		accumulator, err = evaluateLambda(arguments[2], []RuntimeValue{accumulator, member}, ev, env)
		if err != nil {
			return nil, err
		}
	}
	return accumulator, nil
}

func evaluateLambda(lambda any, arguments []RuntimeValue, ev eval, env environment) (RuntimeValue, error) {
	if !isLambda(lambda) {
		return nil, errorf("expected a normalized lambda")
	}
	parameters, ok := jsonField(lambda, "parameters").([]any)
	if !ok {
		return nil, errorf("normalized lambda has no parameters")
	}
	if len(parameters) != len(arguments) {
		return nil, errorf("lambda expects %d arguments, received %d", len(parameters), len(arguments))
	}
	nested := env
	for i, parameter := range parameters {
		name, ok := parameter.(string)
		if !ok {
			return nil, errorf("normalized lambda parameter is not a name")
		}
		nested = nested.with(name, arguments[i])
	}
	return evaluateExpression(jsonField(lambda, "body"), ev, nested)
}

func evaluateMatchVariant(arguments []any, ev eval, env environment) (RuntimeValue, error) {
	if len(arguments) == 0 {
		return nil, errorf("matchVariant has no value")
	}
	variant, err := evaluateExpression(arguments[0], ev, env)
	if err != nil {
		return nil, err
	}
	var tag string
	var payload RuntimeValue
	switch variant := variant.(type) {
	case Absent:
		tag = "Absent"
	case Present:
		tag, payload = "Present", variant.Value
	case Variant:
		tag, payload = variant.Tag, variant.Value
	case Text:
		tag, payload = string(variant), Tuple{}
	default:
		return nil, errorf("matchVariant value is not a normalized variant")
	}
	branches := arguments[1:]
	for i := 0; i+1 < len(branches); i += 2 {
		branchTag, err := evaluateExpression(branches[i], ev, env)
		if err != nil {
			return nil, err
		}
		text, ok := branchTag.(Text)
		if !ok {
			return nil, errorf("matchVariant tag is not text")
		}
		// `_` is Quint's default branch: it matches whatever no earlier branch did.
		if string(text) != tag && string(text) != "_" {
			continue
		}
		lambda := branches[i+1]
		if !isLambda(lambda) {
			return nil, errorf("matchVariant branch is not a lambda")
		}
		parameter, ok := firstParameter(lambda)
		if !ok {
			return nil, errorf("matchVariant lambda has no parameter")
		}
		branchEnv := env
		if payload != nil {
			branchEnv = env.with(parameter, payload)
		}
		return evaluateExpression(jsonField(lambda, "body"), ev, branchEnv)
	}
	return nil, errorf("matchVariant has no matching branch")
}
