package twophasecommit

import (
	"strings"
	"testing"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
)

func TestCommitRunRefinesTheModel(t *testing.T) {
	evaluated, err := RefineCommitRun()
	if err != nil {
		t.Fatal(err)
	}
	if evaluated != 14 {
		t.Errorf("commitRun evaluated %d obligations, want 14", evaluated)
	}
}

func TestRefineAllRunsEveryGeneratedScenario(t *testing.T) {
	results, err := RefineAll(NewCoordinatorFromState)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, result := range results {
		names = append(names, result.Scenario)
	}
	want := "two_phase_commit.commitRun,two_phase_commit.abortBeforePrepareRun"
	if got := strings.Join(names, ","); got != want {
		t.Errorf("scenarios = %s, want %s", got, want)
	}
}

// earlyCommit commits without ever flushing the WAL: durability is lost.
type earlyCommit struct{ *Coordinator }

func (c *earlyCommit) Commit([]refinements.ResolvedAction) ([]refinements.Evidence, error) {
	c.state.Status = Committed
	c.state.Wal = append(c.state.Wal, "prepare", "commit")
	done := c.State()
	return []refinements.Evidence{done, done, done}, nil
}

func TestACommitThatSkipsTheFlushIsReportedAsADivergence(t *testing.T) {
	_, err := RefineAll(func(initial refinements.RuntimeValue) (*earlyCommit, error) {
		inner, err := NewCoordinatorFromState(initial)
		return &earlyCommit{Coordinator: inner}, err
	})
	if err == nil {
		t.Fatal("a commit that skips the flush must not refine the model")
	}
	const want = "two_phase_commit.commitRun:prepare "
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %q, want it to name %q", err, want)
	}
	t.Log(err)
}
