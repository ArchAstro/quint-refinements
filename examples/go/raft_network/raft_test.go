package main

import "testing"

func TestClusterRefinesEveryRaftScenarioWithRustObligationCounts(t *testing.T) {
	want := map[string]int{
		"raft.electionRun":        26,
		"raft.replicationRun":     46,
		"raft.reorderedAppendRun": 36,
		"raft.staleVoteRun":       22,
		"raft.splitVoteRun":       31,
		"raft.staleLogRun":        54,
		"raft.staleAckRun":        50,
		"raft.partitionRun":       53,
	}
	results, err := RefineAll(newAdapter)
	if err != nil {
		t.Fatalf("refinement failed: %v", err)
	}
	if len(results) != len(want) {
		t.Fatalf("got %d scenarios, want %d", len(results), len(want))
	}
	for _, r := range results {
		if want[r.Scenario] != r.EvaluatedObligations {
			t.Errorf("%s: got %d obligations, want %d", r.Scenario, r.EvaluatedObligations, want[r.Scenario])
		}
	}
}

func TestVotesGoToLogsAtLeastAsUpToDate(t *testing.T) {
	vote := func(cand, voter []int64) bool {
		c := newCluster([]string{"c", "v"})
		must(t, c.timeout("c"))
		c.nodes["c"].log, c.nodes["v"].log = cand, voter
		must(t, c.requestVote("c", "v"))
		must(t, c.deliver(0, kindRequestVote))
		return c.msgs[1].ok
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

func TestLeadersCountOnlyWhatFollowersStoreNow(t *testing.T) {
	c := newCluster([]string{"n1", "n2", "n3"})
	n1 := c.nodes["n1"]
	n1.term, n1.role, n1.log = 2, leader, []int64{1}
	n1.matched["n2"] = 1
	if c.commit("n1", 1) == nil {
		t.Error("entry 1 is from an older term")
	}
	n2 := c.nodes["n2"]
	n2.term, n2.log = 2, []int64{2}
	n2.matched["n3"] = 1
	if c.commit("n2", 1) == nil {
		t.Error("n2 is not the leader")
	}
	refused := newMsg(kindAck, "n3", "n1", 2)
	refused.index = 1
	c.msgs = append(c.msgs, refused)
	must(t, c.deliver(0, kindAck))
	if got := c.nodes["n1"].matched["n3"]; got != 0 {
		t.Errorf("a refused ack counts nothing; matched = %d", got)
	}
}

func TestRejectedAppendChangesNothing(t *testing.T) {
	c := newCluster([]string{"n1", "n2"})
	c.nodes["n2"].term = 2
	stale := newMsg(kindAppend, "n1", "n2", 1)
	stale.log, stale.commit = []int64{1}, 1
	c.msgs = append(c.msgs, stale)
	must(t, c.deliver(0, kindAppend))
	n2 := c.nodes["n2"]
	if n2.role != follower || n2.commit != 0 || len(n2.log) != 0 {
		t.Errorf("n2 changed: %+v", n2)
	}
	if c.msgs[1].ok {
		t.Error("stale append must be refused")
	}
}

func TestClusterRefusesWhatRaftRefuses(t *testing.T) {
	c := newCluster([]string{"n1", "n2", "n3"})
	refuse := func(err error, why string) {
		t.Helper()
		if err == nil {
			t.Error(why)
		}
	}
	refuse(c.requestVote("n1", "n2"), "n1 is not campaigning")
	refuse(c.sendAppend("n1", "n2"), "n1 is not the leader")
	refuse(c.clientRequest("n1"), "n1 is not the leader")
	refuse(c.deliver(0, kindVote), "nothing was sent")
	must(t, c.timeout("n1"))
	refuse(c.requestVote("n1", "n1"), "no request to itself")
	refuse(c.becomeLeader("n1"), "one vote is not a majority")
	must(t, c.requestVote("n1", "n2")) // 0
	refuse(c.deliver(0, kindAppend), "0 is a vote request")
	must(t, c.deliver(0, kindRequestVote)) // 1
	must(t, c.deliver(1, kindVote))
	refuse(c.becomeLeader("n2"), "n2 is not a candidate")
	must(t, c.becomeLeader("n1"))
	refuse(c.becomeLeader("n1"), "n1 already leads")
	refuse(c.requestVote("n1", "n3"), "a leader is not campaigning")
	refuse(c.timeout("n1"), "a leader does not time out")
	refuse(c.sendAppend("n1", "n1"), "no append to itself")
	refuse(c.commit("n1", 1), "the log is empty")
	must(t, c.clientRequest("n1"))
	refuse(c.commit("n1", 1), "only n1 stores the entry")
	must(t, c.sendAppend("n1", "n2")) // 2
	must(t, c.deliver(2, kindAppend)) // 3
	must(t, c.deliver(3, kindAck))
	must(t, c.commit("n1", 1))
	refuse(c.commit("n1", 1), "entry 1 is already committed")
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
