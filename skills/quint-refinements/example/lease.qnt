module lease {
  type Lease = { holder: str, expires: int }
  type State = {
    now: int,
    lease: Lease,
    // History flag: set by the action that decides, read by an invariant.
    tookLiveLease: bool,
  }

  pure val TTL = 3
  // Design switch. true is what production does.
  pure val CHECK_EXPIRY = true
  pure val machines = Set("m1", "m2")

  var state: State

  pure def live(s: State): bool = s.lease.holder != "" and s.now < s.lease.expires

  action init = state' = { now: 0, lease: { holder: "", expires: 0 }, tookLiveLease: false }

  action claim(m: str): bool = all {
    not(CHECK_EXPIRY) or not(live(state)) or state.lease.holder == m,
    state' = {
      ...state,
      lease: { holder: m, expires: state.now + TTL },
      tookLiveLease: state.tookLiveLease or (live(state) and state.lease.holder != m),
    },
  }

  action tick = state' = { ...state, now: state.now + 1 }

  action step = any {
    tick,
    nondet m = machines.oneOf()
    claim(m),
  }

  val neverTakesALiveLease = not(state.tookLiveLease)
  // Witness: must be violated, or the walk never claims anything.
  val neverClaimed = state.lease.holder == ""
}
