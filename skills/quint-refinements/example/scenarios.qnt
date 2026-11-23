module scenarios {
  import lease.* from "./lease"

  /// @conformance
  run expiredLeaseIsTakenRun = init
    .then(claim("m1"))
    .then(tick)
    .then(tick)
    .then(tick)
    .then(claim("m2"))
    .then(all {
      assert(state.lease.holder == "m2"),
      state' = state,
    })

  // Not replayed: the model must refuse this step.
  run liveLeaseIsRefusedTest = init
    .then(claim("m1"))
    .then(claim("m2"))
    .fail()
}
