// Command bank_account checks a Go bank against the Quint model in bank.qnt.
//
//go:generate node ../../../packages/compiler/cli.mjs compile bank.qnt --go generated_refinement.go --go-package main
package main

import (
	"fmt"
	"os"
)

func main() {
	results, err := RefineAll(newAdapter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bank refinement failed: %v\n", err)
		os.Exit(1)
	}
	for _, result := range results {
		fmt.Printf("%s refined %d obligations; final balance %d\n",
			result.Scenario, result.EvaluatedObligations, result.Implementation.balance)
	}
}
