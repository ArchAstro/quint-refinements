# How it works

`quint-refinements` checks that an implementation is a *refinement* of a Quint model: for every scenario the model allows, the implementation can take the same steps and end up in the same observable states.

```text
            compile time                              test time
model.qnt ──> quint parse ──> quint test ──┐
                  │           (one trace   │
                  │            per run)    ▼
                  └──────────> quint-refinements.json ──> runner ──> your code
                               src/generated_refinement.rs            │
                                                     snapshots <──────┘
                                                         │
                                         guards and next state checked
```

## 1. What `compile` reads from the model

1. **Scenarios.** Each `run` with `/// @conformance`. A scenario is an initializer followed by actions, with observation blocks (`all { assert(...), state' = state }`) where you assert something.
2. **Actions.** For each action a scenario calls, its definition is split into conjuncts:
   - a conjunct without `state'` is a **guard**;
   - `state' = ...` is the **next-state assignment**.
3. **Arguments.** Each call's arguments, with parameters substituted into the guards and the assignment. `withdraw(4)` yields the guard `4 > 0`, not `amount > 0`.
4. **Constants.** Any named value a scenario or action refers to (`coffee`, `statuses`) is evaluated by Quint and stored with its concrete value.
5. **The trace.** Quint runs each scenario once and records the state after every step. The first state seeds your implementation; later states back actions that have no single assignment (step 4 below).

Helper definitions are inlined, so a guard that calls `isOpen(state)` is checked as the expression `isOpen` stands for.

## 2. What is in `quint-refinements.json`

One entry per scenario. The bank tutorial's looks like this, abbreviated:

```json
{
  "module": "bank",
  "name": "withdrawRun",
  "initialState": { "balance": { "#bigint": "10" } },
  "steps": [
    { "kind": "init", "action": "init" },
    {
      "kind": "action",
      "action": "withdraw",
      "arguments": [{ "kind": "int", "value": 4 }],
      "guards": [
        { "expression": "4 > 0" },
        { "expression": "state.balance >= 4" }
      ],
      "next": [
        { "expression": "state' = { balance: state.balance - 4 }" }
      ]
    },
    { "kind": "observe", "assertions": [{ "expression": "state.balance == 6" }] }
  ]
}
```

In the real file each expression is a small tree (`{"kind": "call", "operator": "igt", ...}`), not text, and lists the state paths it reads. The file also carries a digest of the model sources and the vocabulary of actions and operators used.

## 3. What is in `src/generated_refinement.rs`

1. **`Implementation`**, a trait with:
   - `from_initial_state` and `snapshot`, which translate between your type and the model's `state`;
   - one method per action, or one per `@primitive`;
   - `fixtures`, which defaults to the model's own values for its constants.
2. **Ownership records** saying which method performs which actions.
3. **`refine_all`**, which runs every scenario.

## 4. What happens when you run it

For each scenario, `refine_all`:

1. Builds your implementation from the scenario's initial state and takes a snapshot.
2. Walks the actions in order. For each one it calls your method with the scenario's arguments, then takes a snapshot.
3. Checks every **guard** against the snapshot *before* the action.
4. Checks the **next state**: it evaluates the right-hand side of `state' = ...` on the snapshot before the action and compares the result with the complete snapshot after it. Fields the action should not have touched are compared too.
5. Counts each guard and assignment it evaluated. That is the "refined N obligations" number.

Two cases refine this picture:

1. **Actions without a single assignment.** An action written with `if`/`else`, `any` or `nondet` has no one `state' = ...` conjunct. For those, the obligation is the exact state Quint reached after that step in its own run of the scenario.
2. **One command, several actions.** A `@primitive` method is called once and must return one snapshot per action. Each action's guards and assignment are checked against its own pair of snapshots.

## 5. Reading a failure

```text
bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)
└──────┬───────┘ └───┬──┘ └┬─┘                          └─────┬─────┘ └───┬────────┘ └────┬────────┘
   scenario        action  kind                              where      model says     code produced
```

The kind is `next` when a next-state assignment failed. Other messages you may see:

| Message | Meaning |
|---|---|
| `guard assertion evaluated false` | The implementation was in a state where the model does not allow this action. |
| `primitive X owns 3 actions but returned 1 evidence snapshots` | A `@primitive` method did not return a snapshot per action. |
| `fixture NAME JSON diverged` | A constant you bound in `fixtures` differs from the model's value. |

## 6. What this does and does not prove

1. It proves: on every `@conformance` scenario, your code's observable state follows the model step by step.
2. It does not explore states the scenarios do not visit. Use `quint run` and `quint verify` to check the model itself, then write scenarios for the behaviors you want pinned to the code.
3. It trusts `snapshot`. If your snapshot reports a field the code did not really change, the check passes on a false report. Build snapshots from real state.
