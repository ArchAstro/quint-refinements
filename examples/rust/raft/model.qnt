/// Raft in its smallest checkable form: three nodes, leader election, log
/// replication and commit. A log entry is just the term it was written in.
///
/// Simplification: a follower that accepts a leader copies the leader's whole
/// log, instead of Raft's per-index consistency check and repair. With the
/// election restriction in `grantVote`, the follower ends up the same.
module raft {
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

  /// The term of the last entry, or 0 for an empty log.
  pure def lastTerm(log: List[int]): int =
    if (log.length() == 0) 0 else log[log.length() - 1]

  /// Raft's election restriction: the candidate's log is at least as
  /// up to date, compared by last term first, then by length.
  pure def upToDate(candidate: List[int], voter: List[int]): bool =
    lastTerm(candidate) > lastTerm(voter)
      or (lastTerm(candidate) == lastTerm(voter) and candidate.length() >= voter.length())

  action init = all {
    state' = {
      nodes: NODES.mapBy(_ => {
        term: 0, role: Follower, votedFor: "", votes: Set(), log: [], commit: 0,
      }),
    },
  }

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

  /// A candidate with votes from a majority leads its term.
  action becomeLeader(n: str): bool = all {
    state.nodes.get(n).role == Candidate,
    state.nodes.get(n).votes.size() >= QUORUM,
    state' = { nodes: state.nodes.set(n, { ...state.nodes.get(n), role: Leader }) },
  }

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

  /// A split vote: n1 and n2 both campaign, n1 tries again in a new term and
  /// starts counting votes from scratch.
  /// @conformance
  run splitVoteRun = init
    .then(timeout("n1"))
    .then(grantVote("n3", "n1"))
    .then(timeout("n2"))
    .then(timeout("n2"))
    .then(grantVote("n1", "n2"))
    .then(timeout("n1"))
    .then(all {
      assert(state.nodes.get("n1").votes == Set("n1")),
      state' = state,
    })

  /// n2 inherits an uncommitted entry from term 1. It cannot commit it
  /// directly; committing its own term-2 entry commits both.
  /// @conformance
  run olderTermEntryRun = init
    .then(timeout("n1"))
    .then(grantVote("n2", "n1"))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(appendEntries("n1", "n2"))
    .then(timeout("n2"))
    .then(grantVote("n3", "n2"))
    .then(becomeLeader("n2"))
    .then(clientRequest("n2"))
    .then(appendEntries("n2", "n3"))
    .then(commit("n2", 2))
    .then(all {
      assert(state.nodes.get("n2").log == [1, 2]),
      assert(state.nodes.get("n2").commit == 2),
      state' = state,
    })

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

  /// A new leader that has not committed anything yet does not move a
  /// follower's commit point backwards.
  /// @conformance
  run commitStaysRun = init
    .then(timeout("n1"))
    .then(grantVote("n2", "n1"))
    .then(becomeLeader("n1"))
    .then(clientRequest("n1"))
    .then(appendEntries("n1", "n3"))
    .then(appendEntries("n1", "n2"))
    .then(commit("n1", 1))
    .then(appendEntries("n1", "n2"))
    .then(timeout("n3"))
    .then(grantVote("n2", "n3"))
    .then(becomeLeader("n3"))
    .then(appendEntries("n3", "n2"))
    .then(all {
      assert(state.nodes.get("n2").commit == 1),
      state' = state,
    })

  // Safety, checked by simulation rather than by the scenarios:
  //   quint run model.qnt --step=step --invariant=safety --max-steps=40

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

  /// At most one leader per term.
  val electionSafety = NODES.forall(a => NODES.forall(b =>
    (a != b and state.nodes.get(a).role == Leader and state.nodes.get(b).role == Leader)
      implies state.nodes.get(a).term != state.nodes.get(b).term
  ))

  /// Nodes agree on every entry either has committed.
  val committedAgree = NODES.forall(a => NODES.forall(b =>
    1.to(state.nodes.get(a).commit).forall(i =>
      i <= state.nodes.get(b).commit implies
        state.nodes.get(a).log[i - 1] == state.nodes.get(b).log[i - 1]
    )
  ))

  /// A leader of a newer term holds every committed entry.
  val leaderCompleteness = NODES.forall(a => NODES.forall(l =>
    state.nodes.get(l).role == Leader implies
      1.to(state.nodes.get(a).commit).forall(i =>
        state.nodes.get(a).log[i - 1] <= state.nodes.get(l).term implies all {
          i <= state.nodes.get(l).log.length(),
          state.nodes.get(l).log[i - 1] == state.nodes.get(a).log[i - 1],
        }
      )
  ))

  val safety = electionSafety and committedAgree and leaderCompleteness
}
