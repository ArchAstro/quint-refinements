// Command raft_network checks a Go Raft cluster against the Quint model in
// model.qnt (copied from the Rust example).
package main

import (
	"fmt"
	"os"
)

func main() {
	results, err := RefineAll(newAdapter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "refinement failed: %v\n", err)
		os.Exit(1)
	}
	for _, result := range results {
		fmt.Printf("%s refined %d obligations\n", result.Scenario, result.EvaluatedObligations)
	}
}
