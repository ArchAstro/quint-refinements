# Guide: Raft

Raft keeps a replicated log consistent across a cluster: nodes elect a leader, the leader appends client commands to its log, copies the log to followers, and commits an entry once a majority stores it. This guide models that in about 130 lines of Quint, checks the model's safety with Quint's simulator, implements it in about 250 lines of Rust using only the standard library, and checks the Rust against the model.

The finished project is [`examples/rust/raft`](../../examples/rust/raft).

```text
            timeout              majority of votes
 Follower ──────────> Candidate ──────────────────> Leader
    ^                     │                           │
    └─────────────────────┴───── sees a newer term ───┘
```

| Step | You learn |
|---|---|
| 1 | Keeping a whole cluster in one `state` record: a map from node name to node |
| 2 to 3 | Elections, replication and commit as six Quint actions |
| 4 | Checking the model's safety with the simulator, and the bug it found in this guide's first draft |
| 5 | Scenarios that pin the implementation to the model |
| 6 to 7 | A lean Rust cluster, its snapshot, and what scenarios cannot reach |
| 8 | The Raft bugs the checker catches |

## 1. Model the cluster as one record

```console
npx quint-refinements new raft-check
cd raft-check
```

In `model.qnt`, each node is a record, and the cluster is a map from node name to node. A log entry is just the term it was written in; the commands themselves do not affect the protocol.

<!-- from examples/rust/raft/model.qnt -->
```quint
  type Role = Follower | Candidate | Leader

  type Node = {
    term: int,
    role: Role,
    votedFor: str,
    votes: Set[str],
    log: List[int],
    commit: int,
  }

  type State = { nodes: str -> Node }

  pure val NODES = Set("n1", "n2", "n3")
  pure val QUORUM = 2

  var state: State
```

`state` holds the whole cluster, which is what the checker needs: one snapshot, compared field by field.

## 2. Elections

A node that hears nothing from a leader times out, moves to the next term and votes for itself:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// No heartbeat arrived: start an election in the next term, voting for itself.
  action timeout(n: str): bool = all {
    state.nodes.get(n).role != Leader,
    state' = {
      nodes: state.nodes.set(n, {
        ...state.nodes.get(n),
        term: state.nodes.get(n).term + 1,
        role: Candidate,
        votedFor: n,
        votes: Set(n),
      }),
    },
  }
```

A node votes only for a newer term, so at most once per term. It also votes only for a candidate whose log is at least as *up to date* as its own: Raft compares the term of the last entry first, and length only when those are equal.

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// The term of the last entry, or 0 for an empty log.
  pure def lastTerm(log: List[int]): int =
    if (log.length() == 0) 0 else log[log.length() - 1]

  /// Raft's election restriction: the candidate's log is at least as
  /// up to date, compared by last term first, then by length.
  pure def upToDate(candidate: List[int], voter: List[int]): bool =
    lastTerm(candidate) > lastTerm(voter)
      or (lastTerm(candidate) == lastTerm(voter) and candidate.length() >= voter.length())
```

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A node votes at most once per term, and only for a candidate whose log is
  /// at least as up to date as its own.
  action grantVote(voter: str, candidate: str): bool = all {
    state.nodes.get(candidate).role == Candidate,
    state.nodes.get(candidate).term > state.nodes.get(voter).term,
    upToDate(state.nodes.get(candidate).log, state.nodes.get(voter).log),
    state' = {
      nodes: state.nodes
        .set(voter, {
          ...state.nodes.get(voter),
          term: state.nodes.get(candidate).term,
          role: Follower,
          votedFor: candidate,
        })
        .set(candidate, {
          ...state.nodes.get(candidate),
          votes: state.nodes.get(candidate).votes.union(Set(voter)),
        }),
    },
  }
```

That second rule is what keeps committed entries safe across elections. Section 4 shows what happens without it.

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A candidate with votes from a majority leads its term.
  action becomeLeader(n: str): bool = all {
    state.nodes.get(n).role == Candidate,
    state.nodes.get(n).votes.size() >= QUORUM,
    state' = { nodes: state.nodes.set(n, { ...state.nodes.get(n), role: Leader }) },
  }
```

`QUORUM` is a named constant. With three nodes, two votes win.

## 3. Replication and commit

The leader appends client commands to its own log, tagged with its term:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A client command lands at the end of the leader's log, tagged with its term.
  action clientRequest(n: str): bool = all {
    state.nodes.get(n).role == Leader,
    state' = {
      nodes: state.nodes.set(n, {
        ...state.nodes.get(n),
        log: state.nodes.get(n).log.append(state.nodes.get(n).term),
      }),
    },
  }
```

A follower accepts any other leader whose term is not older than its own. Accepting makes it a follower in that term, which is also how a deposed leader steps down. Its commit point never moves backwards: a newly elected leader starts at 0 until it commits in its own term.

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A follower accepts a leader of its term or newer, steps down if it was
  /// leading an older term, and adopts the leader's log. Its commit point only
  /// moves forward.
  action appendEntries(leader: str, follower: str): bool = all {
    leader != follower,
    state.nodes.get(leader).role == Leader,
    state.nodes.get(leader).term >= state.nodes.get(follower).term,
    state' = {
      nodes: state.nodes.set(follower, {
        ...state.nodes.get(follower),
        term: state.nodes.get(leader).term,
        role: Follower,
        log: state.nodes.get(leader).log,
        commit: if (state.nodes.get(leader).commit > state.nodes.get(follower).commit)
          state.nodes.get(leader).commit
        else
          state.nodes.get(follower).commit,
      }),
    },
  }
```

This is the model's one simplification: the follower copies the leader's whole log. Real Raft sends only new entries and repairs a diverging follower index by index. Because the election restriction guarantees the leader holds every committed entry, the follower ends up in the same state.

An entry commits once a majority stores that same entry, and Raft's subtle rule applies: a leader commits by counting only entries from its own term. Entries from earlier terms are committed indirectly, by committing a later entry.

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// The leader commits entry `index` once a majority stores that same entry.
  /// Raft only commits this way for entries from the leader's own term, and
  /// matching terms at one index mean matching logs up to it.
  action commit(leader: str, index: int): bool = all {
    state.nodes.get(leader).role == Leader,
    index > state.nodes.get(leader).commit,
    index <= state.nodes.get(leader).log.length(),
    state.nodes.get(leader).log[index - 1] == state.nodes.get(leader).term,
    NODES.filter(m => all {
      state.nodes.get(m).log.length() >= index,
      state.nodes.get(m).log[index - 1] == state.nodes.get(leader).term,
    }).size() >= QUORUM,
    state' = {
      nodes: state.nodes.set(leader, { ...state.nodes.get(leader), commit: index }),
    },
  }
```

## 4. Check the model's safety

Scenarios check that the code follows the model. They say nothing about whether the model is right. For that, give Quint a step that can take any action with any arguments:

<!-- from examples/rust/raft/model.qnt -->
```quint
  action step = {
    nondet a = NODES.oneOf()
    nondet b = NODES.oneOf()
    nondet index = 1.to(4).oneOf()
    any {
      timeout(a),
      grantVote(a, b),
      becomeLeader(a),
      clientRequest(a),
      appendEntries(a, b),
      commit(a, index),
    }
  }
```

and the properties Raft promises, such as:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// At most one leader per term.
  val electionSafety = NODES.forall(a => NODES.forall(b =>
    (a != b and state.nodes.get(a).role == Leader and state.nodes.get(b).role == Leader)
      implies state.nodes.get(a).term != state.nodes.get(b).term
  ))
```

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// Nodes agree on every entry either has committed.
  val committedAgree = NODES.forall(a => NODES.forall(b =>
    1.to(state.nodes.get(a).commit).forall(i =>
      i <= state.nodes.get(b).commit implies
        state.nodes.get(a).log[i - 1] == state.nodes.get(b).log[i - 1]
    )
  ))
```

`safety` combines those with Leader Completeness: a leader of a newer term holds every committed entry. The simulator then explores random executions:

```console
npx quint run model.qnt --step=step --invariant=safety --max-steps=40
```

```text
[ok] No violation found (2784ms at 7184 traces/second).
```

The first draft of this guide had a vote check that compared log length only, and a commit that counted nodes by log length. Both look plausible. With that model, the same command fails in under a second: a node whose log is long but stale wins an election and overwrites an entry another node has already committed. The fixes are the `upToDate` guard in section 2, and counting matching entries in `commit`. Run the simulator before you trust a model; scenarios cannot find this kind of bug.

## 5. Scenarios

Seven `@conformance` runs pin the implementation to the model. The first:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// @conformance
  run electionRun = init
    .then(timeout("n1"))
    .then(grantVote("n2", "n1"))
    .then(becomeLeader("n1"))
    .then(all {
      assert(state.nodes.get("n1").role == Leader),
      assert(state.nodes.get("n1").term == 1),
      state' = state,
    })
```

The election restriction, from the side where it lets a shorter log win:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// Raft's election restriction: n3's log [2] is shorter than n1's [1, 1],
  /// but its last entry is from a newer term, so n1 votes for it.
  /// @conformance
  run upToDateRun = init
    .then(timeout("n1"))
    .then(grantVote("n2", "n1"))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(clientRequest("n1"))
    .then(timeout("n2"))
    .then(grantVote("n3", "n2"))
    .then(becomeLeader("n2"))
    .then(clientRequest("n2"))
    .then(appendEntries("n2", "n3"))
    .then(timeout("n3"))
    .then(grantVote("n1", "n3"))
    .then(all {
      assert(state.nodes.get("n1").votedFor == "n3"),
      state' = state,
    })
```

| Run | Shows |
|---|---|
| `electionRun` | A candidate wins with two of three votes |
| `replicationRun` | An entry is replicated, committed, and every follower learns the commit point |
| `newLeaderRun` | A new leader's first message makes the old leader step down |
| `splitVoteRun` | Two candidates split the vote; a new election counts votes from scratch |
| `olderTermEntryRun` | An entry from an older term commits only when a current-term entry does |
| `upToDateRun` | A shorter log with a newer last term wins the vote |
| `commitStaysRun` | A new leader does not move a follower's commit point backwards |

Run them in Quint, then generate:

```console
npx quint test model.qnt --match Run
npx quint-refinements compile
```

The generated trait asks for one method per action: `timeout`, `grant_vote`, `become_leader`, `client_request`, `append_entries` and `commit`.

## 6. Implement the cluster

The code under test is plain Rust: nodes in a `BTreeMap`, standard library only. A tuple compares the last term first, then the length, which is exactly Raft's up-to-date order:

<!-- from examples/rust/raft/src/main.rs -->
```rust
#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    Follower,
    Candidate,
    Leader,
}

#[derive(Clone)]
struct Node {
    term: i64,
    role: Role,
    voted_for: String,
    votes: BTreeSet<String>,
    /// The term of each entry; the commands themselves do not matter here.
    log: Vec<i64>,
    commit: i64,
}

impl Node {
    /// How up to date the log is: last term first, then length.
    fn log_rank(&self) -> (i64, usize) {
        (self.log.last().copied().unwrap_or(0), self.log.len())
    }
}
```

Each Raft rule is a method that returns an error when Raft would refuse. Voting:

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn request_vote(&mut self, candidate: &str, voter: &str) -> Result<(), String> {
        let (term, rank) = match self.node(candidate)? {
            c if c.role == Role::Candidate => (c.term, c.log_rank()),
            _ => return Err(format!("{candidate} is not campaigning")),
        };
        let v = self.node_mut(voter)?;
        if term <= v.term || rank < v.log_rank() {
            return Err(format!("{voter} refuses to vote for {candidate}"));
        }
        v.term = term;
        v.role = Role::Follower;
        candidate.clone_into(&mut v.voted_for);
        self.node_mut(candidate)?.votes.insert(voter.to_owned());
        Ok(())
    }
```

Replication and commit:

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn append_entries(&mut self, leader: &str, follower: &str) -> Result<(), String> {
        let l = self.node(leader)?.clone();
        let f = self.node_mut(follower)?;
        if leader == follower || l.role != Role::Leader || l.term < f.term {
            return Err(format!("{follower} rejects stale leader {leader}"));
        }
        f.term = l.term;
        f.role = Role::Follower;
        f.log = l.log;
        f.commit = f.commit.max(l.commit);
        Ok(())
    }
```

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn commit(&mut self, leader: &str, index: i64) -> Result<(), String> {
        // Raft commits by counting only entries from the leader's own term.
        // Only the leader writes those, so it holds every one it counts.
        let term = self.node(leader)?.term;
        let position = usize::try_from(index - 1).ok();
        let holds = |node: &Node| position.and_then(|i| node.log.get(i)) == Some(&term);
        let stored = self.nodes.values().filter(|node| holds(node)).count();
        let quorum = self.quorum();
        let l = self.node_mut(leader)?;
        if l.role != Role::Leader || index <= l.commit || stored < quorum {
            return Err(format!("{leader} cannot commit entry {index}"));
        }
        l.commit = index;
        Ok(())
    }
```

The trait methods only unpack the scenario's arguments and call those methods:

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn grant_vote(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [voter, candidate] = args(arguments)?;
        self.request_vote(text(candidate)?, text(voter)?)
    }
```

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn commit(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [leader, RuntimeValue::Int(index)] = args(arguments)? else {
            return Err(format!("commit expects a node and an index: {arguments:?}"));
        };
        self.commit(text(leader)?, *index)
    }
```

### What scenarios cannot reach

A scenario only takes steps the model allows, so it never asks the code to do something Raft forbids. The `if ... return Err` branches above are therefore never run by `refine_all`. Delete one and every scenario still passes. Cover them with ordinary unit tests that call the methods directly:

<!-- from examples/rust/raft/src/main.rs -->
```rust
    /// The election restriction, on logs no scenario reaches.
    #[test]
    fn votes_go_to_logs_at_least_as_up_to_date() {
        let vote = |candidate: Vec<i64>, voter: Vec<i64>| {
            let mut c = Cluster::new(["c", "v"].map(String::from));
            c.timeout("c").unwrap();
            c.nodes.get_mut("c").unwrap().log = candidate;
            c.nodes.get_mut("v").unwrap().log = voter;
            c.request_vote("c", "v").is_ok()
        };
        assert!(vote(vec![2], vec![1, 1]), "a newer last term beats length");
        assert!(!vote(vec![1, 1], vec![2]), "an older last term loses");
        assert!(!vote(vec![2], vec![2, 2]), "same last term: shorter loses");
        assert!(vote(vec![2, 2], vec![2, 2]), "an equal log wins");
    }
```

The [finished file](../../examples/rust/raft/src/main.rs) has a second test that walks through every refusal.

## 7. Snapshot the cluster

`resolve_name("state")` turns the cluster into the model's `{ nodes: str -> Node }`. Node names become map keys, roles become their variant names:

<!-- from examples/rust/raft/src/main.rs -->
```rust
/// The model's `state`: `{ nodes: str -> Node }`.
impl NormalizedRuntimeEvidence for Cluster {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        use RuntimeValue::{Int, List, Map, Record, Set, Text};
        if name != "state" {
            return Err(format!("unknown model name {name}"));
        }
        let nodes = self.nodes.iter().map(|(name, n)| {
            let fields = [
                ("term", Int(n.term)),
                ("role", Text(format!("{:?}", n.role))),
                ("votedFor", Text(n.voted_for.clone())),
                ("votes", Set(n.votes.iter().cloned().map(Text).collect())),
                ("log", List(n.log.iter().copied().map(Int).collect())),
                ("commit", Int(n.commit)),
            ];
            let fields = fields.map(|(field, value)| (field.to_owned(), value));
            (Text(name.clone()), Record(fields.into()))
        });
        Ok(Record([("nodes".to_owned(), Map(nodes.collect()))].into()))
    }
```

`Cluster` is its own snapshot type, so `snapshot` is `self.clone()`, and `from_initial_state` reads the node names from the model's initial map.

```console
cargo run
```

```text
raft.electionRun refined 9 obligations
raft.replicationRun refined 29 obligations
raft.newLeaderRun refined 22 obligations
raft.splitVoteRun refined 16 obligations
raft.olderTermEntryRun refined 36 obligations
raft.upToDateRun refined 34 obligations
raft.commitStaysRun refined 42 obligations
```

## 8. What the checker catches

Each entry is one deleted or changed line in `src/main.rs`, and the failure it produces. The path names the node and the field.

**A deposed leader that does not step down.** Delete `f.role = Role::Follower;` from `append_entries`:

```text
refinement failed: raft.newLeaderRun:appendEntries next: assign state diverged at state.nodes["n1"].role expected Text("Follower"), observed Text("Leader")
```

Two leaders in term 2: the bug Raft's terms exist to prevent.

**A vote that does not adopt the candidate's term.** Delete `v.term = term;` from `request_vote`:

```text
refinement failed: raft.electionRun:grantVote next: assign state diverged at state.nodes["n2"].term expected Int(1), observed Int(0)
```

`n2` could vote again in term 1.

**A follower that never learns the commit point.** Delete `f.commit = f.commit.max(l.commit);`:

```text
refinement failed: raft.replicationRun:appendEntries next: assign state diverged at state.nodes["n3"].commit expected Int(1), observed Int(0)
```

**Entries written without their term.** Change `node.log.push(node.term)` to `node.log.push(0)`:

```text
refinement failed: raft.replicationRun:clientRequest next: assign state diverged at state.nodes["n1"].log[0] expected Int(1), observed Int(0)
```

Between the scenarios and the unit tests, each of 29 single-line mutations of `src/main.rs`, from dropped checks to off-by-one indices, fails `cargo test`.

## Where to go from here

1. Add an invariant of your own, such as "a node's commit point never exceeds its log length", and run the simulator.
2. Replace whole-log copying with Raft's `prevLogIndex` check, in the model first. Run the simulator, then the scenarios.
3. Add a fourth node and set `QUORUM` to 3. The Rust derives its quorum from the cluster size, so only the model changes.

Next: [Raft over a real network](raft-network.md), where messages are lost, delayed, reordered and duplicated.
