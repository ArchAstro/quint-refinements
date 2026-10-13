# Guide: Raft

Raft keeps a replicated log consistent across a cluster: nodes elect a leader, the leader appends client commands to its log, copies the log to followers, and commits an entry once a majority stores it. This guide models that in about 160 lines of Quint, implements it in about 250 lines of Rust with no dependencies beyond `quint-refinements`, and checks one against the other.

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
| 4 | Scenarios that pin down election, commit and a leader stepping down |
| 5 to 6 | A lean Rust cluster, and how a map-shaped state is snapshotted |
| 7 | The Raft bugs the checker catches |

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

<!-- from examples/rust/raft/model.qnt -->
```quint
  action init = all {
    state' = {
      nodes: NODES.mapBy(_ => {
        term: 0, role: Follower, votedFor: "", votes: Set(), log: [], commit: 0,
      }),
    },
  }

  /// No heartbeat
```

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

  /// A node votes
```

Two guards make an election safe. A node votes only for a newer term, and so at most once per term, and only for a candidate whose log is at least as long as its own, so a new leader never lacks committed entries:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A node votes at most once per term, and only for a candidate whose log is
  /// at least as long as its own.
  action grantVote(voter: str, candidate: str): bool = all {
    state.nodes.get(candidate).role == Candidate,
    state.nodes.get(candidate).term > state.nodes.get(voter).term,
    state.nodes.get(candidate).log.length() >= state.nodes.get(voter).log.length(),
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

  /// A candidate with
```

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A candidate with votes from a majority leads its term.
  action becomeLeader(n: str): bool = all {
    state.nodes.get(n).role == Candidate,
    state.nodes.get(n).votes.size() >= QUORUM,
    state' = { nodes: state.nodes.set(n, { ...state.nodes.get(n), role: Leader }) },
  }

  /// A client
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

  /// A follower
```

A follower accepts any leader whose term is not older than its own. Accepting makes it a follower in that term, which is also how a deposed leader steps down:

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// A follower accepts a leader of its term or newer, steps down if it was
  /// leading an older term, and adopts the leader's log and commit point.
  action appendEntries(leader: str, follower: str): bool = all {
    state.nodes.get(leader).role == Leader,
    state.nodes.get(leader).term >= state.nodes.get(follower).term,
    state' = {
      nodes: state.nodes.set(follower, {
        ...state.nodes.get(follower),
        term: state.nodes.get(leader).term,
        role: Follower,
        log: state.nodes.get(leader).log,
        commit: state.nodes.get(leader).commit,
      }),
    },
  }

  /// The leader commits
```

This is the model's one simplification: the follower copies the leader's whole log. Real Raft sends only new entries and repairs a diverging follower index by index; the outcome on the follower is the same.

An entry commits once a majority stores it, and Raft's subtle rule applies: a leader commits by counting only entries from its own term.

<!-- from examples/rust/raft/model.qnt -->
```quint
  /// The leader commits entry `index` once a majority stores it. Raft only
  /// commits this way for entries from the leader's own term.
  action commit(leader: str, index: int): bool = all {
    state.nodes.get(leader).role == Leader,
    index > state.nodes.get(leader).commit,
    state.nodes.get(leader).log[index - 1] == state.nodes.get(leader).term,
    NODES.filter(m => state.nodes.get(m).log.length() >= index).size() >= QUORUM,
    state' = {
      nodes: state.nodes.set(leader, { ...state.nodes.get(leader), commit: index }),
    },
  }

  /// @conformance
```

## 4. Scenarios

Three runs, each marked `@conformance`:

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

  /// The entry commits once n1 and n2 store it; n2 learns the commit point on
  /// the next heartbeat.
  /// @conformance
  run replicationRun = init
    .then(timeout("n1"))
    .then(grantVote("n2", "n1"))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(appendEntries("n1", "n2"))
    .then(commit("n1", 1))
    .then(appendEntries("n1", "n3"))
    .then(appendEntries("n1", "n2"))
    .then(all {
      assert(NODES.forall(n => state.nodes.get(n).commit == 1)),
      state' = state,
    })

  /// n1 leads term 1 and is cut off. n2 wins term 2 with n3's vote, and its
  /// first message makes the old leader step down.
  /// @conformance
  run newLeaderRun = init
    .then(timeout("n1"))
    .then(grantVote("n2", "n1"))
    .then(becomeLeader("n1"))
    .then(timeout("n2"))
    .then(grantVote("n3", "n2"))
    .then(becomeLeader("n2"))
    .then(appendEntries("n2", "n1"))
    .then(all {
      assert(state.nodes.get("n1").role == Follower),
      assert(state.nodes.get("n2").role == Leader),
      assert(state.nodes.get("n1").term == 2),
      state' = state,
    })
```

Check the model on its own first, then generate:

```console
npx quint test model.qnt
npx quint-refinements compile
```

The generated trait asks for one method per action: `timeout`, `grant_vote`, `become_leader`, `client_request`, `append_entries` and `commit`.

## 5. Implement the cluster

The code under test is plain Rust: nodes in a `BTreeMap`, standard library only.

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

/// The code under test: a Raft cluster whose nodes share one process.
#[derive(Clone)]
struct Cluster {
    nodes: BTreeMap<String, Node>,
}

impl Cluster
```

Each Raft rule is a method that refuses what Raft refuses. Voting:

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn request_vote(&mut self, candidate: &str, voter: &str) -> Result<(), String> {
        let (term, log_len) = match self.node(candidate)? {
            c if c.role == Role::Candidate => (c.term, c.log.len()),
            _ => return Err(format!("{candidate} is not campaigning")),
        };
        let v = self.node_mut(voter)?;
        if term <= v.term || log_len < v.log.len() {
            return Err(format!("{voter} refuses to vote for {candidate}"));
        }
        v.term = term;
        v.role = Role::Follower;
        v.voted_for = candidate.to_owned();
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
        if l.role != Role::Leader || l.term < f.term {
            return Err(format!("{follower} rejects stale leader {leader}"));
        }
        f.term = l.term;
        f.role = Role::Follower;
        f.log = l.log;
        f.commit = l.commit;
        Ok(())
    }
```

<!-- from examples/rust/raft/src/main.rs -->
```rust
    fn commit(&mut self, leader: &str, index: i64) -> Result<(), String> {
        let stored = self
            .nodes
            .values()
            .filter(|node| node.log.len() as i64 >= index)
            .count();
        let quorum = self.quorum();
        let l = self.node_mut(leader)?;
        let own_term = index >= 1 && l.log.get(index as usize - 1) == Some(&l.term);
        if l.role != Role::Leader || index <= l.commit || !own_term || stored < quorum {
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

## 6. Snapshot the cluster

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

`Cluster` is its own snapshot type, so `snapshot` is `self.clone()`, and `from_initial_state` reads the node names from the model's initial map. The [finished file](../../examples/rust/raft/src/main.rs) has both, plus `main`.

```console
cargo run
```

```text
raft.electionRun refined 9 obligations
raft.replicationRun refined 25 obligations
raft.newLeaderRun refined 21 obligations
```

## 7. What the checker catches

Each line below is one deleted or changed line in `src/main.rs`, and the failure it produces. The path names the node and the field.

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

**A follower that never learns the commit point.** Delete `f.commit = l.commit;`:

```text
refinement failed: raft.replicationRun:appendEntries next: assign state diverged at state.nodes["n3"].commit expected Int(1), observed Int(0)
```

**Entries written without their term.** Change `node.log.push(node.term)` to `node.log.push(0)`:

```text
refinement failed: raft.replicationRun:clientRequest next: assign state diverged at state.nodes["n1"].log[0] expected Int(1), observed Int(0)
```

## Where to go from here

1. Run `quint run model.qnt` with an invariant such as "at most one leader per term" to explore schedules the scenarios do not visit.
2. Add a scenario for a candidate with a shorter log losing an election. The guard on log length is then checked against your code.
3. Replace whole-log copying with Raft's `prevLogIndex` check in both the model and the code.

Next: [keep generated files honest in CI](ci.md).
