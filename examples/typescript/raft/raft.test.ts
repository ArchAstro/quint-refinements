import assert from "node:assert/strict";
import test from "node:test";

import { Cluster, RaftAdapter } from "./raft.ts";
import { refineAll, refineAllSync } from "./generated_refinement.ts";

// The obligation counts the Rust and Go Raft examples report for the same model.
const expected = [
  ["raft.electionRun", 9],
  ["raft.replicationRun", 29],
  ["raft.newLeaderRun", 22],
  ["raft.splitVoteRun", 16],
  ["raft.olderTermEntryRun", 36],
  ["raft.upToDateRun", 34],
  ["raft.commitStaysRun", 42],
];

test("the cluster refines every Raft scenario with the Rust example's obligation counts", () => {
  const results = refineAllSync(RaftAdapter.fromState);
  assert.deepEqual(
    results.map(result => [result.scenario, result.evaluatedObligations]),
    expected,
  );
});

test("the async runner agrees", async () => {
  const results = await refineAll(RaftAdapter.fromState);
  assert.deepEqual(
    results.map(result => [result.scenario, result.evaluatedObligations]),
    expected,
  );
});

/** Records the vote on the voter but never tells the candidate. */
class LostVote extends RaftAdapter {
  override grantVote(args: Parameters<RaftAdapter["grantVote"]>[0]): void {
    const [voter, candidate] = args.map(arg => (arg.kind === "text" ? arg.value : ""));
    const voterNode = this.cluster.nodes.get(voter!)!;
    voterNode.term = this.cluster.nodes.get(candidate!)!.term;
    voterNode.role = "Follower";
    voterNode.votedFor = candidate!;
  }
}

test("a vote the candidate never hears about diverges from the model", () => {
  assert.throws(
    () => refineAllSync(initial => new LostVote(RaftAdapter.fromState(initial).cluster)),
    {
      message:
        'raft.electionRun:grantVote next: assign state diverged at state.nodes["n1"].votes expected Set({Text("n1"), Text("n2")}), observed Set({Text("n1")})',
    },
  );
});

test("votes go to logs at least as up to date", () => {
  const vote = (candidate: number[], voter: number[]): boolean => {
    const cluster = new Cluster(["c", "v"]);
    cluster.timeout("c");
    cluster.nodes.get("c")!.log = candidate;
    cluster.nodes.get("v")!.log = voter;
    try {
      cluster.requestVote("c", "v");
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(vote([2], [1, 1]), true, "a newer last term beats length");
  assert.equal(vote([1, 1], [2]), false, "an older last term loses");
  assert.equal(vote([2], [2, 2]), false, "same last term: shorter loses");
  assert.equal(vote([2, 2], [2, 2]), true, "an equal log wins");
});

test("the cluster refuses what Raft refuses", () => {
  const c = new Cluster(["n1", "n2", "n3"]);
  const refused = (action: () => void, why: string): void => assert.throws(action, Error, why);
  refused(() => c.requestVote("n1", "n2"), "n1 is not campaigning");
  refused(() => c.clientRequest("n1"), "n1 is not the leader");
  c.timeout("n1");
  refused(() => c.becomeLeader("n1"), "one vote is not a majority");
  c.requestVote("n1", "n2");
  refused(() => c.requestVote("n1", "n2"), "one vote per term");
  refused(() => c.becomeLeader("n2"), "n2 is not a candidate");
  c.becomeLeader("n1");
  refused(() => c.becomeLeader("n1"), "n1 already leads");
  refused(() => c.requestVote("n1", "n3"), "a leader is not campaigning");
  refused(() => c.timeout("n1"), "a leader does not time out");
  refused(() => c.appendEntries("n2", "n3"), "n2 is not a leader");
  refused(() => c.appendEntries("n1", "n1"), "a leader is not its own follower");
  refused(() => c.commitEntry("n1", 1), "the log is empty");
  c.clientRequest("n1");
  refused(() => c.commitEntry("n1", 1), "only n1 stores the entry");
  c.appendEntries("n1", "n2");
  c.timeout("n3");
  c.timeout("n3");
  refused(() => c.requestVote("n3", "n2"), "n3's log is shorter");
  c.timeout("n2");
  c.timeout("n2");
  c.requestVote("n2", "n3");
  c.becomeLeader("n2");
  refused(() => c.appendEntries("n1", "n2"), "n1's term is stale");
  refused(() => c.commitEntry("n2", 1), "entry 1 is from an older term");
  c.clientRequest("n2");
  c.appendEntries("n2", "n3");
  refused(() => c.commitEntry("n3", 2), "n3 is not the leader");
  c.commitEntry("n2", 2);
  refused(() => c.commitEntry("n2", 2), "entry 2 is already committed");
});
