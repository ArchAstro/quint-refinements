# Generated Elixir

`compile --elixir` writes one Elixir module. You implement the behaviour it declares; it does the rest. The snippets on this page come from the [`bank_account`](../../examples/elixir/bank_account) Elixir example, and the same model drives the [Rust](../../examples/rust/bank_account), [Go](../../examples/go/bank_account) and [TypeScript](../../examples/typescript/bank_account) ones: the runtimes read one artifact and report the same obligations.

```console
npx quint-refinements compile bank.qnt --elixir lib/generated_refinement.ex
```

| Item | What it is |
|---|---|
| [`Implementation`](#the-implementation-behaviour) | The behaviour you implement, nested in the generated module |
| [`refine_all/2`](#refine_all2) | Runs every scenario against a fresh implementation |
| [`run_primitive/4`, `ownership/0`, `retrieve/0`, `artifact/0`](#driving-scenarios-yourself) | The pieces `refine_all/2` is built from |

The file starts with `# @generated`. Never edit it; change the model and compile again. `compile --check` fails when the file no longer matches the model.

## Setting up

1. Add the runtime to `mix.exs`. It has no dependencies and needs Elixir 1.17 or newer on OTP 27 or newer, because it decodes JSON with OTP's `:json`:

   ```elixir
   {:quint_refinements, github: "ArchAstro/quint-refinements", sparse: "bindings/elixir", only: :test}
   ```

   Drop `only: :test` when the generated module lives in `lib/`.
2. Compile the model, as above. Without `--rust` only the Elixir adapter and the artifact are written; no Rust toolchain is involved. Node.js is needed to compile the model, not to run the check.
3. Run the check from an ExUnit test or a script.

The generated module is named after the model's module: `bank` becomes `Bank.GeneratedRefinement`. Pass `--elixir-module MyApp.BankRefinement` to choose another name.

The adapter reads the artifact (`quint-refinements.json` by default) when it is compiled and keeps the text in the module, so the compiled module does not need the file. It is an `@external_resource`: `mix compile` rebuilds the module when the artifact changes.

## The `Implementation` behaviour

<!-- from examples/elixir/bank_account/lib/generated_refinement.ex -->
```elixir
    @doc "Builds the implementation from a scenario's generated initial state."
    @callback from_initial_state(QuintRefinements.Value.t()) :: t()

    @doc "Returns the current observable implementation state."
    @callback snapshot(t()) :: QuintRefinements.Evidence.t()

    @doc "Executes Quint action `withdraw` with its generated arguments."
    @callback withdraw(t(), arguments()) :: t()
```

An Elixir implementation is a value, so every action callback takes the implementation and returns it as the action left it. Each action becomes a callback named in snake_case (`flushWal` and `flush_wal` both become `flush_wal`). A `@primitive` becomes one callback that receives its actions and returns the implementation with one snapshot after each action:

<!-- from examples/elixir/two_phase_commit/lib/generated_refinement.ex -->
```elixir
    @callback commit(t(), actions()) :: {t(), tape()}
```

| Callback | You provide |
|---|---|
| `from_initial_state/1` | The implementation, built from the state the model's initializer produces. |
| `snapshot/1` | The current observable state, as `QuintRefinements.Evidence`. Called after every action. |
| One callback per action | The call into your real code. The second argument is the list of values the scenario passes. |
| One callback per `@primitive` | The call, plus one snapshot after each action it owns. |

A callback that raises fails the scenario with that exception. The compiler rejects model actions named `snapshot` or `fromInitialState`, actions named after a word Elixir reserves (`end`, `rescue`, `when`), and two actions that become the same function name; rename the action or wrap it in a `@primitive`.

When your code already has a `withdraw/2` that takes an integer, write a small adapter module, as the example does:

<!-- from examples/elixir/bank_account/lib/bank.ex -->
```elixir
  @impl true
  def from_initial_state(initial) do
    %Bank{balance: initial |> Access.field("balance") |> Access.as_int()}
  end
```

<!-- from examples/elixir/bank_account/lib/bank.ex -->
```elixir
  @impl true
  def withdraw(%Bank{} = bank, [amount]) do
    case Bank.withdraw(bank, Access.as_int(amount)) do
      {:ok, bank} -> bank
      {:error, reason} -> raise "withdraw failed: #{reason}"
    end
```

For code whose state lives outside the BEAM process, such as rows in a database, the implementation value is whatever handle the callbacks need to reach it (a tenant id, a connection, a struct of identifiers). Callbacks change the database and return the handle; `snapshot/1` reads the rows back.

## `refine_all/2`

<!-- from examples/elixir/bank_account/refine.exs -->
```elixir
  for result <- Bank.GeneratedRefinement.refine_all(Bank.Adapter) do
    IO.puts(
      "#{result.scenario} refined #{result.evaluated_obligations} obligations; " <>
        "final balance #{result.implementation.balance}"
    )
  end
```

`refine_all(module, options \\ [])` takes the module that implements the behaviour. For each scenario it calls `module.from_initial_state/1`, runs the scenario, and returns a map with `:scenario`, `:evaluated_obligations` and `:implementation` (the implementation as the last action left it). Scenarios run one after another.

The first divergence stops the run and raises a `QuintRefinements.Error`, for example `bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)`. The messages are the other runtimes', so a line that says `Rust fixture` or `rust` is naming the implementation side.

In an ExUnit test, call it and assert on the result; an error fails the test with the divergence as its message:

```elixir
test "the bank refines the model" do
  assert [%{evaluated_obligations: 3}] = Bank.GeneratedRefinement.refine_all(Bank.Adapter)
end
```

Options:

1. `:fixtures` is a function from the parsed artifact to a `QuintRefinements.Fixtures` table. It binds model constants to production values (see [fixtures](#fixtures)).
2. `:artifact` supplies an already parsed artifact instead of the one the module was compiled with.

## Values

Arguments, the initial state and snapshots are all `QuintRefinements.Value` terms, tagged tuples you can pattern match:

| Quint | Term | Build with | Read with |
|---|---|---|---|
| `bool` | `{:bool, true}` | `Value.bool(true)` | `Access.as_bool(value)` |
| `int` | `{:int, 6}` | `Value.int(6)` | `Access.as_int(value)` |
| `str`, or a variant with no payload such as `Open` | `{:text, "Open"}` | `Value.text("Open")` | `Access.as_text(value)` |
| `Set[T]` | `{:set, members}` | `Value.set([...])`, `Value.text_set([...])` | `Value.set_contains?(value, member)` |
| `List[T]` | `{:list, items}` | `Value.list([...])` | `Access.as_list(value)` |
| Tuple | `{:tuple, items}` | `Value.tuple([...])` | pattern match |
| `a -> b` | `{:map, [{key, value}]}` | `Value.map([{key, value}, ...])` | `Value.map_get(value, key)` |
| Record | `{:record, %{"field" => value}}` | `Value.record(field: value)` | `Access.field(value, "field")` |
| A variant with a payload | `{:variant, "Ok", value}` | `Value.variant("Ok", value)` | pattern match |
| `Absent` / `Present(x)` | `:absent` / `{:present, x}` | `Value.absent()`, `Value.present(x)` | pattern match |

Quint integers are unbounded, as Elixir's are. Build sets and maps with `Value.set/1` and `Value.map/1`, not by writing the tuple: the constructors put members in the order every runtime iterates in, so folds and error messages agree across languages. Text sorts by code point, which is UTF-8 byte order, as in Rust. The `QuintRefinements.Access` readers raise a `QuintRefinements.Error` that shows the value they did not expect.

## Snapshots

A snapshot is a `QuintRefinements.Evidence`: it resolves the name `"state"` to the model's `state` record, built from real implementation state. When the state is the only thing to report, `Evidence.state/1` is a ready-made snapshot:

<!-- from examples/elixir/bank_account/lib/bank.ex -->
```elixir
  @impl true
  def snapshot(%Bank{balance: balance}),
    do: Evidence.state(Value.record(balance: Value.int(balance)))
```

`Evidence.new/2` takes a second, optional function that answers model operators your code owns; return `nil` to fall through to the built-in evaluation. A name the evidence does not own is `nil`, which the runtime reports as `unknown evidence name <name>`.

The check is only as honest as the snapshot. Read the fields from the code under test; do not compute what the model expects.

## Fixtures

By default every model constant has the value the model gives it, and you write nothing. Pass `:fixtures` to bind a constant to a production value, so the two cannot drift:

<!-- from examples/elixir/two_phase_commit/lib/coordinator.ex -->
```elixir
  def fixtures(_artifact \\ nil) do
    members =
      for status <- @statuses do
        tag = Atom.to_string(status)
        {%{"tag" => tag, "value" => %{"#tup" => []}}, Value.text(tag)}
      end

    Fixtures.insert_set(Fixtures.new("two_phase_commit"), "statuses", members)
  end
```

A fixture is a pair: the JSON shape the model produces, and the runtime value. The runner fails if a fixture's JSON and the model disagree. `Fixtures.int/1` and `Fixtures.text/1` cover plain values.

## Driving scenarios yourself

The generated module exports `ownership/0`, `retrieve/0`, `artifact/0` and `run_primitive/4`, so you can run a scenario without `refine_all/2`. The runtime provides `QuintRefinements.Drive.refine_scenario/7` for a driver that runs one command per ownership record, `run_refined_actions/6` for an action-at-a-time driver, and `QuintRefinements.Drive.Session`, the step-by-step reducer under it. Each takes the implementation and returns it beside the result. The [bank example's test](../../examples/elixir/bank_account/test/bank_test.exs) runs the shared corpus with `refine_scenario/7` directly.

## Differences from the other runtimes

1. The implementation is an immutable value threaded through the callbacks, where the Rust, Go and TypeScript adapters call methods on a mutable one. A driver function returns the implementation with its evidence.
2. There is one runner. A callback that waits on a process, a socket or a database blocks, so there is no asynchronous form.
3. Integers are unbounded, as in TypeScript. Go reports an error when `iadd` or `isub` leaves the `i64` range, and Rust panics in debug builds and wraps in release builds.
4. Errors are raised as `QuintRefinements.Error` rather than returned.
5. Artifact parse errors name the same fields, and a malformed JSON document is reported in this runtime's words.
6. The JSON reader accepts a repeated key in an artifact (the last wins; serde rejects it for struct fields).
7. A divergence message that quotes a string decides which characters to escape from Unicode general categories, where Rust uses the `Grapheme_Extend` property. The two differ for a few dozen spacing marks.
8. `compile --elixir` does not add a language to `new`, and the compiler does not run `mix format`: it writes lists one item per line, which the formatter leaves alone.
9. Three corner cases differ from TypeScript: a number too large for a double (`1e999`) is a JSON error here, an out-of-range `guardList` or `nextList` that is not an integer is printed in JSON form, and an operator that starts with a squared Latin capital such as `🄰` is not taken as a variant constructor.
10. The Raft examples are not ported; `bank_account` and `two_phase_commit` are.
