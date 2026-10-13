/// Raft in its smallest checkable form: three nodes, leader election, log
/// replication and commit. A log entry is just the term it was written in.
///
/// Simplification: a follower that accepts a leader copies the leader's whole
/// log, instead of Raft's per-index consistency check and repair.
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
}
