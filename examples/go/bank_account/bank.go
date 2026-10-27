package main

import (
	"errors"
	"fmt"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
)

// Bank is the code under test: a one-account bank.
type Bank struct {
	balance int64
}

// Withdraw takes amount out of the account.
func (b *Bank) Withdraw(amount int64) error {
	if amount <= 0 {
		return errors.New("withdrawal must be positive")
	}
	if b.balance < amount {
		return errors.New("insufficient funds")
	}
	b.balance -= amount
	return nil
}

// snapshot is what the refinement checker may observe after each action.
type snapshot struct {
	balance int64
}

func (s snapshot) ResolveName(name string) (refinements.RuntimeValue, error) {
	if name == "state" {
		return refinements.Record{"balance": refinements.Int(s.balance)}, nil
	}
	return nil, fmt.Errorf("unknown evidence name %s", name)
}

func (snapshot) ResolveCall(string, []refinements.RuntimeValue) (refinements.RuntimeValue, bool, error) {
	return nil, false, nil
}

// adapter connects Bank to the generated Implementation interface. The
// generated method takes Quint's arguments; the real one takes an int64.
type adapter struct {
	*Bank
}

// newAdapter builds a Bank from the scenario's generated initial state.
func newAdapter(initial refinements.RuntimeValue) (*adapter, error) {
	state, ok := initial.(refinements.Record)
	if !ok {
		return nil, fmt.Errorf("expected bank record, got %s", initial)
	}
	balance, ok := state["balance"].(refinements.Int)
	if !ok {
		return nil, fmt.Errorf("bank state has no integer balance: %s", state)
	}
	return &adapter{Bank: &Bank{balance: int64(balance)}}, nil
}

// Snapshot implements Implementation.
func (a *adapter) Snapshot() refinements.Evidence { return snapshot{balance: a.balance} }

// Withdraw implements Implementation.
func (a *adapter) Withdraw(arguments []refinements.RuntimeValue) error {
	amount, ok := singleInt(arguments)
	if !ok {
		return fmt.Errorf("withdraw expects one integer argument: %v", arguments)
	}
	return a.Bank.Withdraw(amount)
}

func singleInt(arguments []refinements.RuntimeValue) (int64, bool) {
	if len(arguments) != 1 {
		return 0, false
	}
	amount, ok := arguments[0].(refinements.Int)
	return int64(amount), ok
}
