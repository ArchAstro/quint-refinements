module scenarios {
  import shop.* from "./shop"

  /// @conformance
  run payBothRun = init
    .then(pay(coffee))
    .then(pay(bagel))
    .then(all {
      assert(state.revenue == 42),
      state' = state,
    })

  /// @conformance
  run refundRun = init
    .then(pay(coffee))
    .then(refund(coffee))
    .then(refund(bagel))
    .then(all {
      assert(all {
        state.revenue == 0,
        state.paid.size() == 0,
      }),
      state' = state,
    })
}
