/// One-account version of the bank from Quint's Getting Started tutorial.
module bank {
  type BankState = { balance: int }

  var state: BankState

  action init = all {
    state' = { balance: 10 },
  }

  action withdraw(amount) = all {
    amount > 0,
    state.balance >= amount,
    state' = { balance: state.balance - amount },
  }

  /// @conformance requires = [bank.withdraw]
  run withdrawRun = init
    .then(withdraw(4))
    .then(all {
      assert(state.balance == 6),
      state' = state,
    })
}
