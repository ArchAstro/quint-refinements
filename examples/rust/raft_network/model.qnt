/// Raft over an unreliable network: three nodes exchange messages that may be
/// delayed, reordered, duplicated or lost. A partition is a stretch in which
/// messages across the cut are not delivered.
///
/// Sent messages stay in `msgs` forever and any of them can be delivered at
/// any time, any number of times. That one rule gives every network fault.
///
/// Simplification: an append carries the leader's whole log, instead of
/// Raft's prevLogIndex and the entries after it.
module raft {
  type Role = Follower | Candidate | Leader
  type Kind = RequestVote | Vote | Append | Ack

  type Node = {
    term: int,
    role: Role,
    votedFor: str,
    votes: Set[str],
    log: List[int],
    commit: int,
    // Leader only: how much of its log each node is known to store.
    matched: str -> int,
  }

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

  pure val NODES = Set("n1", "n2", "n3")
  pure val QUORUM = 2

  var state: State

  pure def message(kind: Kind, src: str, dst: str, term: int): Msg =
    { kind: kind, src: src, dst: dst, term: term, log: [], commit: 0, ok: false, index: 0 }

  pure def lastTerm(log: List[int]): int =
    if (log.length() == 0) 0 else log[log.length() - 1]

  /// Raft's election restriction: last term first, then length.
  pure def upToDate(candidate: List[int], voter: List[int]): bool =
    lastTerm(candidate) > lastTerm(voter)
      or (lastTerm(candidate) == lastTerm(voter) and candidate.length() >= voter.length())

  /// Every message carries a term. Seeing a newer one makes a node a follower
  /// in that term, with no vote cast yet.
  pure def observe(node: Node, term: int): Node =
    if (term > node.term) { ...node, term: term, role: Follower, votedFor: "" } else node

  /// `prefix` is the start of `log`.
  pure def isPrefix(prefix: List[int], log: List[int]): bool =
    prefix.length() <= log.length() and prefix.indices().forall(i => prefix[i] == log[i])

  action init = all {
    state' = {
      nodes: NODES.mapBy(_ => {
        term: 0, role: Follower, votedFor: "", votes: Set(), log: [], commit: 0,
        matched: NODES.mapBy(_ => 0),
      }),
      msgs: [],
    },
  }

  /// No heartbeat arrived: start an election in the next term.
  action timeout(n: str): bool = all {
    state.nodes.get(n).role != Leader,
    state' = {
      ...state,
      nodes: state.nodes.set(n, {
        ...state.nodes.get(n),
        term: state.nodes.get(n).term + 1,
        role: Candidate,
        votedFor: n,
        votes: Set(n),
      }),
    },
  }

  action requestVote(candidate: str, voter: str): bool = all {
    candidate != voter,
    state.nodes.get(candidate).role == Candidate,
    state' = {
      ...state,
      msgs: state.msgs.append({
        ...message(RequestVote, candidate, voter, state.nodes.get(candidate).term),
        log: state.nodes.get(candidate).log,
      }),
    },
  }

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

  action becomeLeader(n: str): bool = all {
    state.nodes.get(n).role == Candidate,
    state.nodes.get(n).votes.size() >= QUORUM,
    state' = {
      ...state,
      nodes: state.nodes.set(n, {
        ...state.nodes.get(n),
        role: Leader,
        matched: NODES.mapBy(_ => 0),
      }),
    },
  }

  action clientRequest(n: str): bool = all {
    state.nodes.get(n).role == Leader,
    state' = {
      ...state,
      nodes: state.nodes.set(n, {
        ...state.nodes.get(n),
        log: state.nodes.get(n).log.append(state.nodes.get(n).term),
      }),
    },
  }

  action sendAppend(leader: str, follower: str): bool = all {
    leader != follower,
    state.nodes.get(leader).role == Leader,
    state' = {
      ...state,
      msgs: state.msgs.append({
        ...message(Append, leader, follower, state.nodes.get(leader).term),
        log: state.nodes.get(leader).log,
        commit: state.nodes.get(leader).commit,
      }),
    },
  }

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

  /// Message indices below are positions in `msgs`, in the order sent.
  /// A duplicate request gets the same answer, and a vote that arrives after
  /// the election changes nothing.
  /// @conformance
  run electionRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(requestVote("n1", "n3")) // 1
    .then(receiveRequestVote(0)) // 2: vote
    .then(receiveRequestVote(0)) // 3: the duplicate, granted again
    .then(receiveVote(2))
    .then(becomeLeader("n1"))
    .then(receiveRequestVote(1)) // 4: a vote after the election
    .then(receiveVote(4))
    .then(all {
      assert(state.nodes.get("n1").role == Leader),
      assert(state.msgs[3].ok),
      assert(state.nodes.get("n1").votes == Set("n1", "n2")),
      state' = state,
    })

  /// @conformance
  run replicationRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1
    .then(receiveVote(1))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(sendAppend("n1", "n2")) // 2
    .then(receiveAppend(2)) // 3: ack
    .then(receiveAck(3))
    .then(commit("n1", 1))
    .then(sendAppend("n1", "n3")) // 4
    .then(receiveAppend(4)) // 5
    .then(sendAppend("n1", "n2")) // 6
    .then(receiveAppend(6)) // 7
    .then(receiveAppend(2)) // 8: a duplicate from before the commit
    .then(all {
      assert(NODES.forall(n => state.nodes.get(n).commit == 1)),
      state' = state,
    })

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

  /// A vote from an earlier election arrives after the candidate has moved on,
  /// and a duplicate of the old request is refused.
  /// @conformance
  run staleVoteRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1: vote for term 1
    .then(timeout("n1"))
    .then(receiveVote(1))
    .then(requestVote("n1", "n2")) // 2
    .then(receiveRequestVote(2)) // 3: vote for term 2
    .then(receiveRequestVote(0)) // 4: the term-1 request again, refused
    .then(all {
      assert(state.nodes.get("n1").votes == Set("n1")),
      assert(state.msgs[4].ok == false),
      state' = state,
    })

  /// n1 and n2 both campaign in term 1. n3 votes for n1 and refuses n2, and
  /// n1's first append turns n2 back into a follower.
  /// @conformance
  run splitVoteRun = init
    .then(timeout("n1"))
    .then(timeout("n2"))
    .then(requestVote("n1", "n3")) // 0
    .then(requestVote("n2", "n3")) // 1
    .then(receiveRequestVote(0)) // 2: granted
    .then(receiveRequestVote(1)) // 3: refused
    .then(receiveVote(3))
    .then(receiveVote(2))
    .then(becomeLeader("n1"))
    .then(sendAppend("n1", "n2")) // 4
    .then(receiveAppend(4)) // 5
    .then(all {
      assert(state.nodes.get("n2").role == Follower),
      assert(state.nodes.get("n2").votes == Set("n2")),
      state' = state,
    })

  /// A longer log loses to a shorter one whose last entry is newer: n1's
  /// [1, 1] is refused by n3, which holds [2].
  /// @conformance
  run staleLogRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1
    .then(receiveVote(1))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(clientRequest("n1")) // n1: [1, 1], never replicated
    .then(timeout("n2"))
    .then(requestVote("n2", "n1")) // 2
    .then(requestVote("n2", "n3")) // 3
    .then(receiveRequestVote(2)) // 4: refused, but n1 steps down to term 2
    .then(receiveRequestVote(3)) // 5
    .then(receiveVote(5))
    .then(becomeLeader("n2"))
    .then(clientRequest("n2"))
    .then(sendAppend("n2", "n3")) // 6
    .then(receiveAppend(6)) // 7: n3 holds [2]
    .then(timeout("n1"))
    .then(requestVote("n1", "n3")) // 8
    .then(receiveRequestVote(8)) // 9
    .then(all {
      assert(state.msgs[9].ok == false),
      state' = state,
    })

  /// An ack from n1's first term arrives again after n1 has lost and won in
  /// term 3. A new term starts counting from zero, and the old ack is ignored.
  /// @conformance
  run staleAckRun = init
    .then(timeout("n1"))
    .then(requestVote("n1", "n2")) // 0
    .then(receiveRequestVote(0)) // 1
    .then(receiveVote(1))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(sendAppend("n1", "n2")) // 2
    .then(receiveAppend(2)) // 3: ack from term 1
    .then(receiveAck(3))
    .then(timeout("n2"))
    .then(requestVote("n2", "n1")) // 4
    .then(receiveRequestVote(4)) // 5: n1 steps down to term 2
    .then(timeout("n1"))
    .then(requestVote("n1", "n3")) // 6
    .then(receiveRequestVote(6)) // 7
    .then(receiveVote(7))
    .then(becomeLeader("n1"))
    .then(receiveAck(3)) // delivered again, in term 3
    .then(all {
      assert(state.nodes.get("n1").term == 3),
      assert(state.nodes.get("n1").matched.get("n2") == 0),
      state' = state,
    })

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

  // Safety under every interleaving, loss, delay and duplication:
  //   quint run model.qnt --step=step --invariant=safety --max-steps=40

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

  val electionSafety = NODES.forall(a => NODES.forall(b =>
    (a != b and state.nodes.get(a).role == Leader and state.nodes.get(b).role == Leader)
      implies state.nodes.get(a).term != state.nodes.get(b).term
  ))

  val committedAgree = NODES.forall(a => NODES.forall(b =>
    1.to(state.nodes.get(a).commit).forall(i =>
      i <= state.nodes.get(b).commit implies
        state.nodes.get(a).log[i - 1] == state.nodes.get(b).log[i - 1]
    )
  ))

  val leaderCompleteness = NODES.forall(a => NODES.forall(l =>
    state.nodes.get(l).role == Leader implies
      1.to(state.nodes.get(a).commit).forall(i =>
        state.nodes.get(a).log[i - 1] <= state.nodes.get(l).term implies all {
          i <= state.nodes.get(l).log.length(),
          state.nodes.get(l).log[i - 1] == state.nodes.get(a).log[i - 1],
        }
      )
  ))

  /// What a leader counts toward commit, the node really stores: in the
  /// leader's term, the first `matched` entries of both logs agree.
  val matchedIsStored = NODES.forall(l => NODES.forall(n =>
    (state.nodes.get(l).role == Leader and state.nodes.get(n).term == state.nodes.get(l).term)
      implies 1.to(state.nodes.get(l).matched.get(n)).forall(i => all {
        i <= state.nodes.get(n).log.length(),
        state.nodes.get(n).log[i - 1] == state.nodes.get(l).log[i - 1],
      })
  ))

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

  val commitWithinLog = NODES.forall(n => state.nodes.get(n).commit <= state.nodes.get(n).log.length())

  val safety = electionSafety and committedAgree and leaderCompleteness and commitWithinLog
    and matchedIsStored and committedOnMajority
}
