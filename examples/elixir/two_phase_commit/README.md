# Two-phase commit refinement, in Elixir

One client COMMIT is one Elixir function, `Coordinator.commit/2`, while the model has three steps: write PREPARE, flush the WAL, write COMMIT. The model declares that with `@primitive commit = [prepare, flushWal, commitPrepared]`, and the function returns one snapshot after each step.

```console
# From the repository root:
npm ci
cd examples/elixir/two_phase_commit
node ../../../packages/compiler/cli.mjs compile model.qnt --elixir lib/generated_refinement.ex --check
mix run refine.exs
mix test
```

`Coordinator.fixtures/1` binds the model's `statuses` set to the coordinator's own status list, so a status one side adds and the other lacks fails the run.

`test/coordinator_test.exs` also runs a coordinator that commits without flushing and checks that the checker reports `state.status expected Text("Prepared"), observed Text("Committed")`, and it runs the shared conformance case `two_phase_commit`.
