# Generated Go

`compile --go` writes one Go file. You implement its interface; it does the rest. The snippets on this page come from the [`bank_account`](../../examples/go/bank_account) Go example, and the same model drives the [Rust one](../../examples/rust/bank_account): the runtimes read one artifact and report the same obligations.

```console
npx quint-refinements compile bank.qnt --go generated_refinement.go --go-package main
```

| Item | What it is |
|---|---|
| [`Implementation`](#the-implementation-interface) | The interface you implement |
| [`RefineAll`](#refineall) | Runs every scenario against a fresh implementation |
| [`ScenarioResult`](#refineall) | What `RefineAll` returns per scenario |
| [`Driver`, `Ownership`, `Retrieve`, `Artifact`](#driving-scenarios-yourself) | The pieces `RefineAll` is built from |

The file starts with `// Code generated ... DO NOT EDIT.` Never edit it; change the model and compile again.

## The `Implementation` interface

<!-- from examples/go/bank_account/generated_refinement.go -->
```go
// Implementation is the domain implementation connected to the generated Quint
// scenarios. Snapshot must return a value that no later action changes.
type Implementation interface {
	// Snapshot returns the current observable implementation state.
	Snapshot() refinements.Evidence

	// Withdraw executes Quint action `withdraw` with its generated arguments.
	Withdraw(arguments []refinements.RuntimeValue) error
}
```

Each action becomes a method named in Go style (`flushWal` and `flush_wal` both become `FlushWal`). A `@primitive` becomes one method that receives its actions and returns one snapshot after each:

```go
Commit(actions []refinements.ResolvedAction) ([]refinements.Evidence, error)
```

| Member | You provide |
|---|---|
| `Snapshot` | The current observable state, as `Evidence`. Called after every action. |
| One method per action | The call into your real code. `arguments` are the values the scenario passes. |
| One method per `@primitive` | The call, plus one snapshot after each action it owns. |

A method that returns an error fails the scenario with that message. Go cannot overload a method name, so when your production type already has a `Withdraw(int64)`, wrap it in a small adapter type that embeds it and defines the generated method; the example does exactly that.

## `RefineAll`

<!-- from examples/go/bank_account/generated_refinement.go -->
```go
func RefineAll[I Implementation](
	newImplementation func(initialState refinements.RuntimeValue) (I, error),
	options ...Option,
) ([]ScenarioResult[I], error) {
```

`newImplementation` builds a fresh implementation from each scenario's initial state, the state the model's initializer produces. `RefineAll` is generic, so `result.Implementation` has your concrete type and you can inspect it after the run.

<!-- from examples/go/bank_account/main.go -->
```go
	results, err := RefineAll(newAdapter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bank refinement failed: %v\n", err)
		os.Exit(1)
	}
```

The first divergence stops the run and is returned as the error, for example `bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(10)`. The messages are the Rust runtime's, character for character.

## Values

Arguments, the initial state and snapshots are all `refinements.RuntimeValue`:

| Quint | Go type |
|---|---|
| `bool` | `Bool` |
| `int` | `Int` (an `int64`; a larger number is rejected, never rounded) |
| `str`, or a variant with no payload such as `Open` | `Text` |
| `Set[T]` | `Set`, built with `NewSet` or `TextSet` |
| `List[T]` | `List` |
| Tuple | `Tuple` |
| `a -> b` | `Map`, built with `NewMap` and `MapEntry` |
| Record | `Record` (a `map[string]RuntimeValue`) |
| A variant with a payload | `Variant{Tag, Value}` |
| `Absent` / `Present(x)` | `Absent{}` / `Present{Value}` |

Type-switch to take arguments apart:

<!-- from examples/go/bank_account/bank.go -->
```go
func singleInt(arguments []refinements.RuntimeValue) (int64, bool) {
	if len(arguments) != 1 {
		return 0, false
	}
	amount, ok := arguments[0].(refinements.Int)
	return int64(amount), ok
}
```

Values are immutable by convention. Sets and maps keep their members in a fixed order, the same order as the Rust runtime, so folds and error messages agree across languages.

## Snapshots

A snapshot implements `refinements.Evidence`. `ResolveName("state")` returns the model's `state` record built from real implementation state:

<!-- from examples/go/bank_account/bank.go -->
```go
func (s snapshot) ResolveName(name string) (refinements.RuntimeValue, error) {
	if name == "state" {
		return refinements.Record{"balance": refinements.Int(s.balance)}, nil
	}
	return nil, fmt.Errorf("unknown evidence name %s", name)
}

func (snapshot) ResolveCall(string, []refinements.RuntimeValue) (refinements.RuntimeValue, bool, error) {
	return nil, false, nil
}
```

`ResolveCall` answers model operators your code owns; return `false` to fall through to the built-in evaluation. When the state is the only thing to report, `refinements.StateEvidence{State: ...}` is a ready-made snapshot.

The check is only as honest as the snapshot. Read the fields from the code under test; do not compute what the model expects. A snapshot must not change after it is returned, because the runner keeps every one for the whole scenario.

## Fixtures

By default every model constant has the value the model gives it, and you write nothing. Pass `WithFixtures` to bind a constant to a production value, so the two cannot drift:

<!-- from bindings/go/examples/two_phase_commit/coordinator.go -->
```go
func FixtureTable() *refinements.FixtureTable {
	return refinements.NewFixtureTable("two_phase_commit").
		InsertSet("statuses", Aborted, Committed, Idle, Open, Prepared)
}
```

A fixture is a Go type with `ArtifactJSON()` (the JSON shape the model produces) and `RuntimeValue()`. The runner fails if a fixture's JSON and the model disagree. `IntFixture` and `TextFixture` cover plain values.

## Driving scenarios yourself

The generated file exports `Ownership`, `Retrieve`, `Artifact()` and `Driver`, so you can run a scenario without `RefineAll`: `RefineScenario` runs one with a `PrimitiveDriver`, `RunRefinedActions` dispatches one action at a time to an `ActionDriver`, and `RefinementSession` is the step-by-step reducer under it. The [two-phase commit](../../bindings/go/examples/two_phase_commit) package and the shared [corpus test](../../bindings/go/corpus/corpus_test.go) use them.

## Differences from the Rust runtime

1. No async variants. A driver is plain Go and blocks; call your service from inside the method, or run scenarios in goroutines.
2. Integer arithmetic that overflows an `int64` is an error. The Rust runtime panics in debug builds and wraps in release builds.
3. Artifact parse errors name the same fields but are worded by Go's JSON decoder where serde words them differently.
