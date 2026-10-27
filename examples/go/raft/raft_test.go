package main

import "testing"

func TestClusterRefinesEveryRaftScenario(t *testing.T) {
	want := map[string]int{
		"raft.electionRun":       9,
		"raft.replicationRun":    29,
		"raft.newLeaderRun":      22,
		"raft.splitVoteRun":      16,
		"raft.olderTermEntryRun": 36,
		"raft.upToDateRun":       34,
		"raft.commitStaysRun":    42,
	}
	results, err := RefineAll(newAdapter)
	if err != nil {
		t.Fatalf("refinement failed: %v", err)
	}
	if len(results) != len(want) {
		t.Fatalf("got %d scenarios, want %d", len(results), len(want))
	}
	for _, r := range results {
		n, ok := want[r.Scenario]
		if !ok {
			t.Errorf("unexpected scenario %s", r.Scenario)
		} else if r.EvaluatedObligations != n {
			t.Errorf("%s: %d obligations, want %d", r.Scenario, r.EvaluatedObligations, n)
		}
	}
}

func TestVotesGoToLogsAtLeastAsUpToDate(t *testing.T) {
	vote := func(candidate, voter []int64) bool {
		c := NewCluster("c", "v")
		_ = c.timeout("c")
		c.nodes["c"].log = candidate
		c.nodes["v"].log = voter
		return c.requestVote("c", "v") == nil
	}
	if !vote([]int64{2}, []int64{1, 1}) {
		t.Error("a newer last term beats length")
	}
	if vote([]int64{1, 1}, []int64{2}) {
		t.Error("an older last term loses")
	}
	if vote([]int64{2}, []int64{2, 2}) {
		t.Error("same last term: shorter loses")
	}
	if !vote([]int64{2, 2}, []int64{2, 2}) {
		t.Error("an equal log wins")
	}
}

func TestClusterRefusesWhatRaftRefuses(t *testing.T) {
	c := NewCluster("n1", "n2", "n3")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	refused := func(err error, why string) {
		t.Helper()
		if err == nil {
			t.Errorf("expected refusal: %s", why)
		}
	}
	refused(c.requestVote("n1", "n2"), "n1 is not campaigning")
	refused(c.clientRequest("n1"), "n1 is not the leader")
	must(c.timeout("n1"))
	refused(c.becomeLeader("n1"), "one vote is not a majority")
	must(c.requestVote("n1", "n2"))
	refused(c.requestVote("n1", "n2"), "one vote per term")
	refused(c.becomeLeader("n2"), "n2 is not a candidate")
	must(c.becomeLeader("n1"))
	refused(c.becomeLeader("n1"), "n1 already leads")
	refused(c.requestVote("n1", "n3"), "a leader is not campaigning")
	refused(c.timeout("n1"), "a leader does not time out")
	refused(c.appendEntries("n2", "n3"), "n2 is not a leader")
	refused(c.appendEntries("n1", "n1"), "a leader is not its own follower")
	refused(c.commitEntry("n1", 1), "the log is empty")
	must(c.clientRequest("n1"))
	refused(c.commitEntry("n1", 1), "only n1 stores the entry")
	must(c.appendEntries("n1", "n2"))
	must(c.timeout("n3"))
	must(c.timeout("n3"))
	refused(c.requestVote("n3", "n2"), "n3's log is shorter")
	must(c.timeout("n2"))
	must(c.timeout("n2"))
	must(c.requestVote("n2", "n3"))
	must(c.becomeLeader("n2"))
	refused(c.appendEntries("n1", "n2"), "n1's term is stale")
	refused(c.commitEntry("n2", 1), "entry 1 is from an older term")
	must(c.clientRequest("n2"))
	must(c.appendEntries("n2", "n3"))
	refused(c.commitEntry("n3", 2), "n3 is not the leader")
	must(c.commitEntry("n2", 2))
	refused(c.commitEntry("n2", 2), "entry 2 is already committed")
}
