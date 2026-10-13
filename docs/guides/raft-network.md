# Guide: Raft over a real network

In the [Raft guide](raft.md), a node reads another node's state directly: `appendEntries(n1, n2)` copies n1's log into n2 in one step. Real networks are not like that. A message carries the sender's state *at the moment it was sent*, and arrives late, out of order, twice, or never. Most Raft bugs live there.

This guide adds that network to the model, in about 230 lines of Quint, and to the Rust, in about 400 lines with only the standard library. The finished project is [`examples/rust/raft_network`](../../examples/rust/raft_network).

```text
 node ──send──> msgs: every message ever sent, kept forever
                  │
                  └──deliver(i)──> node      any message, at any time, any number of times
```

One rule gives every fault:

| Fault | In the model |
|---|---|
| Loss | A message is never delivered |
| Delay | It is delivered after other things happened |
| Reordering | Message 3 is delivered before message 2 |
| Duplication | The same message is delivered twice |
| Partition | For a while, no message across the cut is delivered |

## 1. Messages are part of the state

`state` now holds the nodes and every message sent. One record shape covers all four kinds, which keeps the model and the Rust snapshot simple:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// One shape for all four kinds; fields a kind does not use stay empty.
  type Msg = {
    kind: Kind,
    src: str,
    dst: str,
    term: int,
    log: List[int],
    commit: int,
    ok: bool,
    index: int,
  }

  type State = { nodes: str -> Node, msgs: List[Msg] }
```

Sending appends to `msgs`. Delivering a message never removes it, so it can be delivered again later.

## 2. Every message carries a term

The first thing a node does with any message is compare terms. A newer term makes it a follower in that term, with no vote cast yet:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// Every message carries a term. Seeing a newer one makes a node a follower
  /// in that term, with no vote cast yet.
  pure def observe(node: Node, term: int): Node =
    if (term > node.term) { ...node, term: term, role: Follower, votedFor: "" } else node
```

Voting then happens on the receiver's side, from what the request carried, not from the candidate's state now:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// Vote at most once per term, for a candidate at least as up to date.
  action receiveRequestVote(i: int): bool = {
    val m = state.msgs[i]
    val voter = observe(state.nodes.get(m.dst), m.term)
    val grant = m.term == voter.term
      and (voter.votedFor == "" or voter.votedFor == m.src)
      and upToDate(m.log, voter.log)
    all {
      i < state.msgs.length(),
      m.kind == RequestVote,
      state' = {
        nodes: state.nodes.set(m.dst, if (grant) { ...voter, votedFor: m.src } else voter),
        msgs: state.msgs.append({ ...message(Vote, m.dst, m.src, voter.term), ok: grant }),
      },
    }
  }
```

The reply goes back into `msgs`. A candidate may receive it long after it has moved to a new election, so a vote counts only for the term it was cast in:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// A vote counts only for the term it was cast in.
  action receiveVote(i: int): bool = {
    val m = state.msgs[i]
    val c = observe(state.nodes.get(m.dst), m.term)
    all {
      i < state.msgs.length(),
      m.kind == Vote,
      state' = {
        ...state,
        nodes: state.nodes.set(m.dst,
          if (m.ok and m.term == c.term and c.role == Candidate)
            { ...c, votes: c.votes.union(Set(m.src)) }
          else c),
      },
    }
  }
```

## 3. Appends that arrive late

The leader sends its log; the follower acknowledges how much it received. Two appends from the same leader can arrive in either order. If the older one, with the shorter log, arrived second and was copied, the follower would lose entries it had already acknowledged. So a log that is already a prefix of the follower's is not copied:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// `prefix` is the start of `log`.
  pure def isPrefix(prefix: List[int], log: List[int]): bool =
    prefix.length() <= log.length() and prefix.indices().forall(i => prefix[i] == log[i])
```

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// Reject an older leader. Otherwise follow it, and take its log unless
  /// that log is already a prefix of ours: a late append from the same leader
  /// must not shorten a log. A log that conflicts is replaced.
  action receiveAppend(i: int): bool = {
    val m = state.msgs[i]
    val f = observe(state.nodes.get(m.dst), m.term)
    val accept = m.term == f.term
    val log = if (isPrefix(m.log, f.log)) f.log else m.log
    all {
      i < state.msgs.length(),
      m.kind == Append,
      state' = {
        nodes: state.nodes.set(m.dst,
          if (accept)
            { ...f, role: Follower, log: log, commit: if (m.commit > f.commit) m.commit else f.commit }
          else f),
        msgs: state.msgs.append({
          ...message(Ack, m.dst, m.src, f.term),
          ok: accept,
          index: m.log.length(),
        }),
      },
    }
  }
```

The commit point only moves forward, for the same reason: a duplicate from before a commit must not undo it.

## 4. Acks and commit

The leader records how much of its log each node holds, from acks of its current term only. An ack from an earlier term describes a log that may since have been overwritten:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// A successful ack from the current term records how much the node stores.
  action receiveAck(i: int): bool = {
    val m = state.msgs[i]
    val l = observe(state.nodes.get(m.dst), m.term)
    all {
      i < state.msgs.length(),
      m.kind == Ack,
      state' = {
        ...state,
        nodes: state.nodes.set(m.dst,
          if (m.ok and m.term == l.term and l.role == Leader and m.index > l.matched.get(m.src))
            { ...l, matched: l.matched.set(m.src, m.index) }
          else l),
      },
    }
  }
```

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// Commit an entry of the leader's own term once a majority stores it.
  action commit(leader: str, index: int): bool = all {
    state.nodes.get(leader).role == Leader,
    index > state.nodes.get(leader).commit,
    index <= state.nodes.get(leader).log.length(),
    state.nodes.get(leader).log[index - 1] == state.nodes.get(leader).term,
    NODES.filter(n => n == leader or state.nodes.get(leader).matched.get(n) >= index).size()
      >= QUORUM,
    state' = {
      ...state,
      nodes: state.nodes.set(leader, { ...state.nodes.get(leader), commit: index }),
    },
  }
```

## 5. Scenarios name messages by position

A scenario delivers message `i`, its position in `msgs`. The comments count them:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// Two appends, and their acks, arrive out of order. The late append must
  /// not shorten n2's log, and the late ack must not lower what n1 counts.
  /// @conformance
  run reorderedAppendRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1
    .then(receiveVote(1))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(sendAppend("n1", "n2")) // 2: log [1]
    .then(clientRequest("n1"))
    .then(sendAppend("n1", "n2")) // 3: log [1, 1]
    .then(receiveAppend(3)) // 4: ack for 2 entries
    .then(receiveAppend(2)) // 5: ack for 1 entry
    .then(receiveAck(4))
    .then(receiveAck(5))
    .then(all {
      assert(state.nodes.get("n2").log == [1, 1]),
      assert(state.nodes.get("n1").matched.get("n2") == 2),
      state' = state,
    })
```

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// n1 leads term 1, then is partitioned from n2 and n3, which elect n2 in
  /// term 2. When the partition heals, n1's appends are rejected and a reply
  /// makes it step down. n2 then replaces n1's uncommitted entry.
  /// @conformance
  run partitionRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1
    .then(receiveVote(1))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1")) // never replicated
    .then(timeout("n2"))
    .then(requestVote("n2", "n3")) // 2
    .then(receiveRequestVote(2)) // 3
    .then(receiveVote(3))
    .then(becomeLeader("n2"))
    .then(sendAppend("n1", "n3")) // 4: from the old leader
    .then(sendAppend("n1", "n2")) // 5
    .then(receiveAppend(4)) // 6: rejected, term 2
    .then(receiveAppend(5)) // 7: rejected; n2 stays leader
    .then(receiveAck(6))
    .then(clientRequest("n2"))
    .then(sendAppend("n2", "n1")) // 8
    .then(receiveAppend(8)) // 9
    .then(all {
      assert(state.nodes.get("n1").role == Follower),
      assert(state.nodes.get("n1").term == 2),
      assert(state.nodes.get("n2").role == Leader),
      assert(state.nodes.get("n3").log == []),
      assert(state.nodes.get("n1").log == [2]),
      state' = state,
    })
```

| Run | Network behaviour it pins down |
|---|---|
| `electionRun` | Request, vote, election; a duplicate request; a vote after the election |
| `replicationRun` | Replication and commit; a duplicate from before the commit does not undo it |
| `reorderedAppendRun` | Appends and acks out of order |
| `staleVoteRun` | A vote from an old election; a duplicate old request is refused |
| `splitVoteRun` | Two candidates in one term; a refused vote; a candidate yields to the leader |
| `staleLogRun` | A longer log loses to one whose last entry is newer |
| `staleAckRun` | An ack from an old term, delivered again after re-election |
| `partitionRun` | An old leader cut off, a new election, the old leader stepping down, its uncommitted entry replaced |

## 6. Safety under a hostile network

`step` picks any action, and any message to deliver. Half of the deliveries pick one of the last few messages: with a uniform choice, a reply is so rarely delivered in time that no follower ever learns of a commit, and the simulator never exercises that path.

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  action step = {
    nondet a = NODES.oneOf()
    nondet b = NODES.oneOf()
    nondet index = 1.to(3).oneOf()
    // Any message, or one of the last few: uniform choice alone rarely
    // delivers a reply soon enough for a commit to reach a follower.
    nondet old = 0.to(state.msgs.length()).oneOf()
    nondet recent = (if (state.msgs.length() > 4) state.msgs.length() - 4 else 0)
      .to(state.msgs.length()).oneOf()
    any {
      timeout(a),
      requestVote(a, b),
      becomeLeader(a),
      clientRequest(a),
      sendAppend(a, b),
      commit(a, index),
      receiveRequestVote(old), receiveRequestVote(recent),
      receiveVote(old), receiveVote(recent),
      receiveAppend(old), receiveAppend(recent),
      receiveAck(old), receiveAck(recent),
    }
  }
```

The safety properties are the ones from the Raft guide, plus two that the network makes necessary. Whatever a leader counts toward commit, the node really stores:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// What a leader counts toward commit, the node really stores: in the
  /// leader's term, the first `matched` entries of both logs agree.
  val matchedIsStored = NODES.forall(l => NODES.forall(n =>
    (state.nodes.get(l).role == Leader and state.nodes.get(n).term == state.nodes.get(l).term)
      implies 1.to(state.nodes.get(l).matched.get(n)).forall(i => all {
        i <= state.nodes.get(n).log.length(),
        state.nodes.get(n).log[i - 1] == state.nodes.get(l).log[i - 1],
      })
  ))
```

and a committed entry is on a majority from the moment it commits:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// A committed entry is stored on a majority, from the moment it commits.
  /// Over-counting what a leader may commit breaks this at once.
  val committedOnMajority = NODES.forall(a =>
    1.to(state.nodes.get(a).commit).forall(i =>
      NODES.filter(n => all {
        i <= state.nodes.get(n).log.length(),
        state.nodes.get(n).log[i - 1] == state.nodes.get(a).log[i - 1],
      }).size() >= QUORUM
    )
  )
```

```console
npx quint run model.qnt --step=step --invariant=safety --max-steps=40
```

### What the simulator finds, and what it does not

Seven of the model's rules were removed one at a time, and each broken model run through the simulator, the scenarios, and one plain Quint test:

| Rule removed | Simulator, 20,000 runs | Scenarios and tests |
|---|---|---|
| A late append must not shorten a log | Found | `reorderedAppendRun` |
| A vote counts only in its own term | Found | `staleVoteRun` |
| An ack counts only in its own term | Not found | `staleAckRun` |
| `matched` starts from zero in a new term | Not found | `staleAckRun` |
| Votes compare last term, not just length | Not found | `staleLogRun` |
| Commit only entries of the leader's term | Not found | `olderTermCommitTest` |
| A newer term clears the old vote | Not found | `olderTermCommitTest` |

The four "not found" safety bugs need long, specific histories, such as a leader losing, a later leader overwriting its log, and the first leader winning again. Random runs rarely build them, even at 300,000 runs. The last row is not a safety bug at all: keeping an old vote only makes a node refuse more, which costs liveness.

So the deep rules get explicit histories. Raft's Figure 8 rule is a plain Quint test, because what it checks is that an action is *not* possible:

<!-- from examples/rust/raft_network/model.qnt -->
```quint
  /// Raft's Figure 8 rule, as a plain Quint test: n1 leads term 3 and its
  /// entry from term 1 is on a majority, but it may not commit it directly.
  /// Random simulation almost never builds this history.
  run olderTermCommitTest = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1
    .then(receiveVote(1))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(sendAppend("n1", "n2")) // 2
    .then(receiveAppend(2)) // 3: n2 holds [1]; the ack is lost
    .then(timeout("n2"))
    .then(requestVote("n2", "n1")) // 4
    .then(receiveRequestVote(4)) // 5: n1 steps down to term 2
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 6
    .then(receiveRequestVote(6)) // 7
    .then(receiveVote(7))
    .then(becomeLeader("n1")) // term 3
    .then(sendAppend("n1", "n2")) // 8
    .then(receiveAppend(8)) // 9
    .then(receiveAck(9))
    .then(commit("n1", 1).fail())
```

```console
npx quint test model.qnt --match Test
```

Treat a passing simulation as evidence, not proof, and write down the histories you know matter.

## 7. The network in Rust

The Rust cluster gains a `Vec<Msg>`. Sending pushes; nothing is removed:

<!-- from examples/rust/raft_network/src/main.rs -->
```rust
/// The code under test: Raft nodes in one process, and the messages between
/// them. Sent messages are kept, so any can be delivered late, out of order,
/// more than once, or never.
#[derive(Clone)]
struct Cluster {
    nodes: BTreeMap<String, Node>,
    msgs: Vec<Msg>,
}
```

One method delivers any message. It checks the kind the scenario expects, applies the term rule, handles the message, and sends the reply:

<!-- from examples/rust/raft_network/src/main.rs -->
```rust
    /// Deliver message `i`, which must be of `kind`, and send any reply.
    fn deliver(&mut self, i: i64, kind: Kind) -> Result<(), String> {
        let m = usize::try_from(i)
            .ok()
            .and_then(|i| self.msgs.get(i))
            .filter(|m| m.kind == kind)
            .cloned()
            .ok_or(format!("no {kind:?} message {i}"))?;
        let node = self.node_mut(&m.dst)?;
        if m.term > node.term {
            node.term = m.term;
            node.role = Role::Follower;
            node.voted_for.clear();
        }
        let current = m.term == node.term;
        let reply = match kind {
            Kind::RequestVote => {
                let free = node.voted_for.is_empty() || node.voted_for == m.src;
                let ok = current && free && rank(&m.log) >= rank(&node.log);
                if ok {
                    m.src.clone_into(&mut node.voted_for);
                }
                Some(Msg {
                    ok,
                    ..Msg::new(Kind::Vote, &m.dst, &m.src, node.term)
                })
            }
            Kind::Vote => {
                if m.ok && current && node.role == Role::Candidate {
                    node.votes.insert(m.src);
                }
                None
            }
            Kind::Append => {
                let index = i64::try_from(m.log.len()).map_err(|e| e.to_string())?;
                if current {
                    node.role = Role::Follower;
                    // A late append from this leader must not shorten the log.
                    if !node.log.starts_with(&m.log) {
                        node.log.clone_from(&m.log);
                    }
                    node.commit = node.commit.max(m.commit);
                }
                Some(Msg {
                    ok: current,
                    index,
                    ..Msg::new(Kind::Ack, &m.dst, &m.src, node.term)
                })
            }
            Kind::Ack => {
                if m.ok && current && node.role == Role::Leader {
                    let matched = node.matched.entry(m.src).or_default();
                    *matched = (*matched).max(m.index);
                }
                None
            }
        };
        self.msgs.extend(reply);
        Ok(())
    }
```

The generated trait has one method per kind; each calls `deliver`:

<!-- from examples/rust/raft_network/src/main.rs -->
```rust
    fn receive_append(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [i] = args(arguments)?;
        self.deliver(int(i)?, Kind::Append)
    }
```

`cargo test` runs every scenario, plus unit tests for refusals and for branches only very long histories reach. Together they fail on each of 43 single-line mutations of `src/main.rs`.

## 8. What the checker catches

**A late append shortens the log.** Always copy the leader's log:

```text
refinement failed: raft.reorderedAppendRun:receiveAppend next: assign state diverged at state.nodes["n2"].log expected list length 2, observed 1
```

**A vote from an old election counts.** Drop the term check in `Kind::Vote`:

```text
refinement failed: raft.staleVoteRun:receiveVote next: assign state diverged at state.nodes["n1"].votes expected Set({Text("n1")}), observed Set({Text("n1"), Text("n2")})
```

**An old ack counts.** Drop the term check in `Kind::Ack`. The simulator misses this one; the scenario does not:

```text
refinement failed: raft.staleAckRun:receiveAck next: assign state diverged at state.nodes["n1"].matched["n2"] expected Int(0), observed Int(1)
```

**A leader ignores a newer term.** Do not step down in the term rule:

```text
refinement failed: raft.staleLogRun:receiveRequestVote next: assign state diverged at state.nodes["n1"].role expected Text("Follower"), observed Text("Leader")
```

## What is still simplified

1. An append carries the whole log, not `prevLogIndex` and the new entries. The prefix rule in section 3 is the part of Raft's consistency check this model needs.
2. There are three nodes and no membership changes, snapshots or client sessions.
3. The simulator explores random executions. Rules it cannot reach are pinned by scenarios and by `olderTermCommitTest`, as section 6 shows.

Next: [keep generated files honest in CI](ci.md).
