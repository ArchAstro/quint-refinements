/// A shop that takes payment for orders and refunds them.
module shop {
  type Order = { id: str, total: int }
  type State = { paid: Set[str], revenue: int }

  pure val coffee: Order = { id: "coffee", total: 30 }
  pure val bagel: Order = { id: "bagel", total: 12 }

  var state: State

  action init = all {
    state' = { paid: Set(), revenue: 0 },
  }

  action pay(order: Order): bool = all {
    not(state.paid.contains(order.id)),
    state' = {
      paid: state.paid.union(Set(order.id)),
      revenue: state.revenue + order.total,
    },
  }

  /// Refunding an unpaid order changes nothing.
  action refund(order: Order): bool =
    if (state.paid.contains(order.id)) {
      state' = {
        paid: state.paid.exclude(Set(order.id)),
        revenue: state.revenue - order.total,
      }
    } else {
      state' = state
    }
}
