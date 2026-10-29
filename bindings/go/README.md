# quint-refinements for Go

Check a Go implementation against a [Quint](https://quint.sh/) model.

This module is the runtime. It drives your implementation through scenarios
generated from the model and evaluates every generated guard and next-state
obligation against the snapshots your code returns. It reads the same
schema-v2 and v3 artifacts as the Rust crate, and reports the same obligations and the
same divergence messages.

```console
go get github.com/ArchAstro/quint-refinements/bindings/go
npx quint-refinements compile model.qnt --go refinement/generated.go
```

Then implement the generated `Implementation` interface for your own type:

```go
results, err := refinement.RefineAll(NewBank) // NewBank(initial RuntimeValue) (*Bank, error)
if err != nil {
	log.Fatalf("Bank does not refine the model: %v", err)
}
for _, result := range results {
	fmt.Printf("%s refined %d obligations\n", result.Scenario, result.EvaluatedObligations)
}
```

The module and the `quint-refinements` npm package release under one version;
use matching versions. The repository
[documentation](https://archastro.github.io/quint-refinements/reference/go)
covers the generated interface, values, snapshots and fixtures.

To drive scenarios yourself, use `RefineScenario`, `RunRefinedActions`, or a
step-by-step `RefinementSession` with the generated `Ownership` and `Retrieve`
tables.

Requires Go 1.22 or newer.
