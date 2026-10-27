package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
)

type expectation struct {
	Scenario             string `json:"scenario"`
	EvaluatedObligations int    `json:"evaluatedObligations"`
	FinalState           struct {
		Balance int64 `json:"balance"`
	} `json:"finalState"`
}

func TestGeneratedQuintWithdrawalDrivesTheRealBankAndChecksItsSnapshot(t *testing.T) {
	// Setup: the compile step generated the scenario and the Go adapter.
	raw, err := os.ReadFile("../../../conformance/cases/bank_withdraw/expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected expectation
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}

	// Boundary: generated ownership passes withdraw(4) to the real Bank.
	results, err := RefineAll(newAdapter)
	if err != nil {
		t.Fatalf("the Go bank refines withdrawRun: %v", err)
	}

	// Outcome: all guards and the assignment match the shared binding corpus.
	if len(results) != 1 {
		t.Fatalf("only withdrawRun should be generated; got %d results", len(results))
	}
	result := results[0]
	if result.Scenario != expected.Scenario {
		t.Errorf("scenario = %s, want %s", result.Scenario, expected.Scenario)
	}
	if result.EvaluatedObligations != expected.EvaluatedObligations {
		t.Errorf("obligations = %d, want %d", result.EvaluatedObligations, expected.EvaluatedObligations)
	}
	if result.Implementation.balance != expected.FinalState.Balance {
		t.Errorf("final balance = %d, want %d", result.Implementation.balance, expected.FinalState.Balance)
	}
}

// brokenBank forgets to take the money out: the model says the balance drops.
type brokenBank struct{ *adapter }

func (b *brokenBank) Withdraw(arguments []refinements.RuntimeValue) error {
	if _, ok := singleInt(arguments); !ok {
		return errors.New("withdraw expects one integer argument")
	}
	return nil
}

func TestADeviatingBankIsReportedAsADivergence(t *testing.T) {
	_, err := RefineAll(func(initial refinements.RuntimeValue) (*brokenBank, error) {
		inner, err := newAdapter(initial)
		return &brokenBank{adapter: inner}, err
	})
	if err == nil {
		t.Fatal("a bank that ignores withdrawals must not refine the model")
	}
	want := `bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(10)`
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %q, want it to contain %q", err, want)
	}
}
