/// Tiny two-phase commit. Not Postgres.
///
/// Client `COMMIT` is one implementation command. The model still has three
/// spec steps: write PREPARE, flush WAL, write COMMIT. The Rust example
/// refines those three with one `commit()` call.
module two_phase_commit {
  type Status = Idle | Open | Prepared | Committed | Aborted

  type Txn = {
    status: Status,
    wal: List[str],
    flushed: bool,
  }

  /// Closed universe of status tags. Membership is a fixture, not live state.
  pure val statuses = Set(Idle, Open, Prepared, Committed, Aborted)

  var state: Txn

  action init = all {
    state' = { status: Idle, wal: [], flushed: false },
  }

  action begin = all {
    statuses.contains(state.status),
    state.status == Idle,
    state' = { status: Open, wal: [], flushed: false },
  }

  action prepare = all {
    statuses.contains(state.status),
    state.status == Open,
    state' = {
      status: Prepared,
      wal: state.wal.append("prepare"),
      flushed: false,
    },
  }

  action flushWal = all {
    statuses.contains(state.status),
    state.status == Prepared,
    state.flushed == false,
    state' = { ...state, flushed: true },
  }

  action commitPrepared = all {
    statuses.contains(state.status),
    state.status == Prepared,
    state.flushed,
    state' = {
      status: Committed,
      wal: state.wal.append("commit"),
      flushed: true,
    },
  }

  action abort = all {
    state.status == Open or state.status == Prepared,
    state' = { ...state, status: Aborted },
  }

  run commitRun = init
    .then(begin)
    .then(prepare)
    .then(flushWal)
    .then(commitPrepared)

  run abortBeforePrepareRun = init
    .then(begin)
    .then(abort)
}
