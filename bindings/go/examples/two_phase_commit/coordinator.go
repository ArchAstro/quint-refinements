// Package twophasecommit is a worked example: a client COMMIT is one Go
// function, while the Quint model still has three spec steps (write PREPARE,
// flush WAL, write COMMIT).
//
// Everything that connects this file to model.qnt lives in generated.go, which
// `quint-refinements compile --go` derives from the model.
//
//go:generate node ../../../../packages/compiler/cli.mjs compile ../../../rust/examples/two_phase_commit/model.qnt --artifact traces.json --go generated.go --go-package twophasecommit
package twophasecommit

import (
	"errors"
	"fmt"
	"slices"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
)

// Status is the transaction status. It owns the Quint `Status` constructors.
type Status string

// The transaction statuses.
const (
	Idle      Status = "Idle"
	Open      Status = "Open"
	Prepared  Status = "Prepared"
	Committed Status = "Committed"
	Aborted   Status = "Aborted"
)

func statusFromTag(tag string) (Status, error) {
	switch status := Status(tag); status {
	case Idle, Open, Prepared, Committed, Aborted:
		return status, nil
	}
	return "", fmt.Errorf("unknown status %s", tag)
}

// ArtifactJSON implements refinements.QuintFixture.
func (s Status) ArtifactJSON() any {
	return map[string]any{"tag": string(s), "value": map[string]any{"#tup": []any{}}}
}

// RuntimeValue implements refinements.QuintFixture.
func (s Status) RuntimeValue() refinements.RuntimeValue { return refinements.Text(s) }

// FixtureTable makes the Quint `statuses` universe this Go enum, not a
// parallel test twin.
func FixtureTable() *refinements.FixtureTable {
	return refinements.NewFixtureTable("two_phase_commit").
		InsertSet("statuses", Aborted, Committed, Idle, Open, Prepared)
}

// Snapshot is what the refinement checker may observe.
type Snapshot struct {
	Status  Status
	Wal     []string
	Flushed bool
}

// ResolveName implements refinements.Evidence.
func (s Snapshot) ResolveName(name string) (refinements.RuntimeValue, error) {
	if name != "state" {
		return nil, fmt.Errorf("unknown name %s", name)
	}
	wal := make(refinements.List, len(s.Wal))
	for i, entry := range s.Wal {
		wal[i] = refinements.Text(entry)
	}
	return refinements.Record{
		"status":  refinements.Text(s.Status),
		"flushed": refinements.Bool(s.Flushed),
		"wal":     wal,
	}, nil
}

// ResolveCall implements refinements.Evidence.
func (Snapshot) ResolveCall(string, []refinements.RuntimeValue) (refinements.RuntimeValue, bool, error) {
	return nil, false, nil
}

// Coordinator is an in-memory stand-in for a Postgres transaction's
// prepare/flush/commit log.
type Coordinator struct {
	state Snapshot
}

// NewCoordinator returns an idle coordinator.
func NewCoordinator() *Coordinator {
	return &Coordinator{state: Snapshot{Status: Idle}}
}

// State returns a copy of the current observable state.
func (c *Coordinator) State() Snapshot {
	snapshot := c.state
	snapshot.Wal = slices.Clone(c.state.Wal)
	return snapshot
}

func (c *Coordinator) begin() error {
	if c.state.Status != Idle {
		return errors.New("begin requires Idle")
	}
	c.state.Status = Open
	return nil
}

func (c *Coordinator) prepare() error {
	if c.state.Status != Open {
		return errors.New("prepare requires Open")
	}
	c.state.Status = Prepared
	c.state.Wal = append(c.state.Wal, "prepare")
	c.state.Flushed = false
	return nil
}

func (c *Coordinator) flushWal() error {
	if c.state.Status != Prepared || c.state.Flushed {
		return errors.New("flush requires unflushed Prepared")
	}
	c.state.Flushed = true
	return nil
}

func (c *Coordinator) commitPrepared() error {
	if c.state.Status != Prepared || !c.state.Flushed {
		return errors.New("commitPrepared requires flushed Prepared")
	}
	c.state.Status = Committed
	c.state.Wal = append(c.state.Wal, "commit")
	return nil
}

func (c *Coordinator) abort() error {
	if c.state.Status != Open && c.state.Status != Prepared {
		return errors.New("abort requires Open or Prepared")
	}
	c.state.Status = Aborted
	return nil
}

// NewCoordinatorFromState builds a coordinator from a scenario's generated
// initial state.
func NewCoordinatorFromState(initial refinements.RuntimeValue) (*Coordinator, error) {
	state, ok := initial.(refinements.Record)
	if !ok {
		return nil, fmt.Errorf("expected a transaction record, got %s", initial)
	}
	var tag string
	switch status := state["status"].(type) {
	case refinements.Text:
		tag = string(status)
	case refinements.Variant:
		tag = status.Tag
	default:
		return nil, fmt.Errorf("transaction has no status tag: %v", state["status"])
	}
	status, err := statusFromTag(tag)
	if err != nil {
		return nil, err
	}
	list, ok := state["wal"].(refinements.List)
	if !ok {
		return nil, fmt.Errorf("transaction has no wal list: %s", state)
	}
	wal := make([]string, len(list))
	for i, entry := range list {
		text, ok := entry.(refinements.Text)
		if !ok {
			return nil, fmt.Errorf("wal entry is not text: %s", entry)
		}
		wal[i] = string(text)
	}
	flushed, ok := state["flushed"].(refinements.Bool)
	if !ok {
		return nil, fmt.Errorf("transaction has no flushed flag: %s", state)
	}
	return &Coordinator{state: Snapshot{Status: status, Wal: wal, Flushed: bool(flushed)}}, nil
}

// Snapshot implements Implementation.
func (c *Coordinator) Snapshot() refinements.Evidence { return c.State() }

// Begin implements Implementation.
func (c *Coordinator) Begin([]refinements.RuntimeValue) error { return c.begin() }

// Abort implements Implementation.
func (c *Coordinator) Abort([]refinements.RuntimeValue) error { return c.abort() }

// Commit implements Implementation: one client COMMIT. Internally prepare,
// flush, commit -- the 1-to-N tape declared by
// `@primitive commit = [prepare, flushWal, commitPrepared]` in the model.
func (c *Coordinator) Commit([]refinements.ResolvedAction) ([]refinements.Evidence, error) {
	if err := c.prepare(); err != nil {
		return nil, err
	}
	prepared := c.State()
	if err := c.flushWal(); err != nil {
		return nil, err
	}
	flushed := c.State()
	if err := c.commitPrepared(); err != nil {
		return nil, err
	}
	return []refinements.Evidence{prepared, flushed, c.State()}, nil
}

// RefineCommitRun runs every generated scenario and returns the obligations
// commitRun evaluated. The `statuses` universe is this package's Status enum.
func RefineCommitRun() (int, error) {
	results, err := RefineAll(NewCoordinatorFromState, WithFixtures(
		func(*refinements.ConformanceArtifact) (*refinements.FixtureTable, error) {
			return FixtureTable(), nil
		}))
	if err != nil {
		return 0, err
	}
	for _, result := range results {
		if result.Scenario == "two_phase_commit.commitRun" {
			return result.EvaluatedObligations, nil
		}
	}
	return 0, errors.New("commitRun missing")
}
