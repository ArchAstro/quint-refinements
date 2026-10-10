---
layout: home
title: Check real code against a Quint model
titleTemplate: quint-refinements

hero:
  name: quint-refinements
  text: Your code does what your Quint model says.
  tagline: Write the model and the implementation. Everything between them is generated, and every guard and state change is checked against what the code actually did.
  actions:
    - theme: brand
      text: Quick start
      link: /quick-start
    - theme: alt
      text: Tutorial
      link: /tutorial
    - theme: alt
      text: How it works
      link: /how-it-works

features:
  - icon: 🧬
    title: Generated from the model
    details: Scenarios, action dispatch, a typed Rust trait and the runner all come from the Quint AST. There are no config files and nothing is registered by hand.
  - icon: 🦀
    title: The compiler tells you what is missing
    details: Add or rename an action, recompile, and cargo names the method your implementation still owes.
  - icon: 🎯
    title: Failures name the divergence
    details: The scenario, the action, the field, what the model expected and what the code produced, in one line.
  - icon: 🧱
    title: One command, several actions
    details: A single production call can own several model steps. Each step is checked against its own snapshot.
  - icon: 🔒
    title: Constants cannot drift
    details: Model constants reach your code as values. Bind one to a production list and the run fails when the two disagree.
  - icon: ✅
    title: One line in CI
    details: compile --check fails the build when a generated file no longer matches the model.
---

<div class="home-section">

## From model to verdict

<p class="lead">You own two files. The compiler owns the two between them.</p>

<div class="home-steps">
  <div class="home-step"><b>1</b><h3>Write the model</h3><p>Ordinary Quint. Mark the runs your code must follow with <code>/// @conformance</code>.</p></div>
  <div class="home-step"><b>2</b><h3>Compile</h3><p><code>quint-refinements compile</code> writes the scenario file and a Rust trait with one method per action.</p></div>
  <div class="home-step"><b>3</b><h3>Implement and run</h3><p>Implement the trait for your real type. <code>cargo run</code> passes, or prints the exact divergence.</p></div>
</div>

<div class="vp-doc">

::: code-group

```quint [model.qnt]
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

  /// @conformance
  run withdrawRun = init
    .then(withdraw(4))
    .then(all {
      assert(state.balance == 6),
      state' = state,
    })
}
```

```rust [src/main.rs]
impl Implementation for Bank {
    type Evidence = Snapshot;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> { /* ... */ }
    fn snapshot(&self) -> Snapshot { /* ... */ }

    // Generated from `action withdraw(amount)`. The scenario supplies the 4.
    fn withdraw(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [RuntimeValue::Int(amount)] = arguments else {
            return Err(format!("withdraw expects one integer: {arguments:?}"));
        };
        self.withdraw(*amount)
    }
}
```

```text [cargo run: passing]
bank.withdrawRun refined 3 obligations; final balance 6
```

```text [cargo run: a bug]
bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)
```

:::

</div>
</div>

<div class="home-section home-end">

## Learn it in four steps

<p class="lead">Each page builds a complete project that CI compiles and runs, so the code you read is the code that passes.</p>

<div class="home-path">
  <a href="./tutorial"><small>1 · Tutorial</small><strong>A bank account</strong><span>The whole loop: model, compile, implement, catch a bug.</span></a>
  <a href="./guides/shop-orders"><small>2 · Guide</small><strong>A shop</strong><span>Named constants, if/else actions, a model in two files.</span></a>
  <a href="./guides/one-command-many-actions"><small>3 · Guide</small><strong>A transaction commit</strong><span>@primitive, intermediate snapshots, binding constants to Rust.</span></a>
  <a href="./guides/ci"><small>4 · Guide</small><strong>CI</strong><span>compile --check, generating into an existing crate.</span></a>
</div>

</div>
