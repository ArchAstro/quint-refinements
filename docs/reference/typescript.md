# Generated TypeScript

`compile --typescript` writes one TypeScript file. You implement its interface; it does the rest. The snippets on this page come from the [`bank_account`](../../examples/typescript/bank_account) TypeScript example, and the same model drives the [Rust](../../examples/rust/bank_account) and [Go](../../examples/go/bank_account) ones: the runtimes read one artifact and report the same obligations.

```console
npx quint-refinements compile bank.qnt --typescript generated_refinement.ts
```

The runtime the adapter imports ships in the same npm package, as `quint-refinements/runtime`. There is no second package to install.

| Item | What it is |
|---|---|
| [`Implementation`](#the-implementation-interface) | The interface you implement |
| [`refineAll`, `refineAllSync`](#refineall) | Run every scenario against a fresh implementation |
| [`ScenarioResult`](#refineall) | What they return per scenario |
| [`driver`, `asyncDriver`, `ownership`, `retrieve`, `artifact`](#driving-scenarios-yourself) | The pieces `refineAll` is built from |

The file starts with `// @generated`. Never edit it; change the model and compile again. `compile --check` fails when the file no longer matches the model.

## Setting up

1. Install the package: `npm install --save-dev quint-refinements typescript @types/node`.
2. Compile the model, as above. Without `--rust` only the TypeScript adapter and the artifact are written; no Rust toolchain is involved.
3. Run your tests with whatever you already use for TypeScript: `tsc`, `tsx`, Vitest, or Node itself (22.18 or newer runs `.ts` files that use no enums or namespaces).

The adapter reads the artifact (`quint-refinements.json` by default) from a path relative to itself, so keep the two together when you build into another directory, or pass the parsed artifact as `options.artifact`.

## The `Implementation` interface

<!-- from examples/typescript/bank_account/generated_refinement.ts -->
```ts
export interface Implementation {
  /** Returns the current observable implementation state. */
  snapshot(): Evidence;

  /** Executes Quint action `withdraw` with its generated arguments. */
  withdraw(args: readonly RuntimeValue[]): void;
}
```

Each action becomes a method named in camelCase (`flushWal` and `flush_wal` both become `flushWal`). A `@primitive` becomes one method that receives its actions and returns one snapshot after each:

<!-- from examples/typescript/two_phase_commit/generated_refinement.ts -->
```ts
  commit(actions: readonly ResolvedAction[]): readonly Evidence[];
```

| Member | You provide |
|---|---|
| `snapshot` | The current observable state, as `Evidence`. Called after every action. |
| One method per action | The call into your real code. `args` are the values the scenario passes. |
| One method per `@primitive` | The call, plus one snapshot after each action it owns. |

A method that throws fails the scenario with that error. The adapter rejects model actions named `snapshot`, `then`, `constructor`, or another name every JavaScript object already owns, and two actions that become the same method name; rename the action or wrap it in a `@primitive`.

When your production type already has a `withdraw(amount: number)`, wrap it in a small adapter class that defines the generated method, as the example does:

<!-- from examples/typescript/bank_account/bank.ts -->
```ts
export class BankAdapter implements Implementation {
  readonly bank: Bank;

  constructor(bank: Bank) {
    this.bank = bank;
  }

  /** Builds a Bank from the scenario's generated initial state. */
  static fromState(initial: RuntimeValue): BankAdapter {
    if (initial.kind !== "record") {
      throw new Error(`expected a bank record, got ${initial.kind}`);
    }
    return new BankAdapter(new Bank(Number(asInt(initial.fields.get("balance")))));
  }
```

A method may declare fewer parameters than the interface passes, so an action with no arguments can be `begin(): void`.

## `refineAll`

<!-- from examples/typescript/bank_account/generated_refinement.ts -->
```ts
export function refineAllSync<I extends Implementation>(
  newImplementation: (initialState: RuntimeValue) => I,
  options: RefineOptions = {},
): ScenarioResult<I>[] {
```

<!-- from examples/typescript/bank_account/generated_refinement.ts -->
```ts
export async function refineAll<I extends MaybeAsync<Implementation>>(
  newImplementation: (initialState: RuntimeValue) => I | Promise<I>,
  options: RefineOptions = {},
): Promise<ScenarioResult<I>[]> {
```

`newImplementation` builds a fresh implementation from each scenario's initial state, the state the model's initializer produces. Both functions are generic, so `result.implementation` has your concrete type and you can inspect it after the run.

1. `refineAllSync` is for implementations whose methods return plain values.
2. `refineAll` also accepts methods that return promises (`MaybeAsync<Implementation>`), and a `newImplementation` that returns one. A synchronous implementation works with it too. Scenarios run one after another, and so do the primitives within each, because each snapshot is the next action's starting point.
3. `refineAllSync` throws if a method returns a promise, instead of checking a snapshot taken before the action finished.

<!-- from examples/typescript/bank_account/main.ts -->
```ts
try {
  for (const result of refineAllSync(BankAdapter.fromState)) {
    console.log(`${result.scenario} refined ${result.evaluatedObligations} obligations; final balance ${result.implementation.bank.balance}`);
  }
} catch (error) {
  console.error(`bank refinement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
```

The first divergence stops the run and is thrown as a `RefinementError`, for example `bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)`. The messages are the Rust and Go runtimes', character for character.

`options.fixtures` binds model constants to production values (see [fixtures](#fixtures)), and `options.artifact` supplies an already parsed artifact.

## Values

Arguments, the initial state and snapshots are all `RuntimeValue`, a discriminated union on `kind`:

| Quint | `kind` | Build with | Read with |
|---|---|---|---|
| `bool` | `"bool"` | `bool(true)` | `asBool(value)` |
| `int` | `"int"` | `int(6)` or `int(6n)` | `asInt(value)`, a `bigint` |
| `str`, or a variant with no payload such as `Open` | `"text"` | `text("Open")` | `asText(value)` |
| `Set[T]` | `"set"` | `set([...])`, `textSet([...])` | `value.members` |
| `List[T]` | `"list"` | `list([...])` | `asList(value)` |
| Tuple | `"tuple"` | `tuple([...])` | `value.items` |
| `a -> b` | `"map"` | `map([[key, value], ...])` | `mapGet(value, key)` |
| Record | `"record"` | `record({ field: value })` | `fieldOf(value, "field")` |
| A variant with a payload | `"variant"` | `variant("Ok", value)` | `value.tag`, `value.value` |
| `Absent` / `Present(x)` | `"absent"` / `"present"` | `absent`, `present(x)` | `value.value` |

Quint integers are unbounded, so `int` holds a `bigint`. `int(6)` accepts a `number` only when it is a safe integer. Values are immutable. Sets and maps keep their members in a fixed order, the same order as the Rust and Go runtimes, so folds and error messages agree across languages. Text sorts by code point, which is UTF-8 byte order, as in Rust.

## Snapshots

A snapshot implements `Evidence`: `resolveName("state")` returns the model's `state` record built from real implementation state. When the state is the only thing to report, `stateEvidence(value)` is a ready-made snapshot:

<!-- from examples/typescript/bank_account/bank.ts -->
```ts
  snapshot(): Evidence {
    return stateEvidence(record({ balance: int(this.bank.balance) }));
  }
```

`Evidence` has one more, optional, member: `resolveCall(operator, args)` answers model operators your code owns; return `undefined` to fall through to the built-in evaluation. A name the evidence does not own is `undefined`, which the runtime reports as `unknown evidence name <name>`.

The check is only as honest as the snapshot. Read the fields from the code under test; do not compute what the model expects. A snapshot must not change after it is returned, because the runner keeps every one for the whole scenario: copy mutable state when you build it, as the [Raft example](../../examples/typescript/raft/raft.ts) does with `clone()`.

## Fixtures

By default every model constant has the value the model gives it, and you write nothing. Pass `options.fixtures` to bind a constant to a production value, so the two cannot drift:

<!-- from examples/typescript/two_phase_commit/coordinator.ts -->
```ts
export function fixtureTable(): FixtureTable {
  return new FixtureTable("two_phase_commit").insertSet("statuses", ...statuses.map(statusFixture));
}
```

A fixture is an object with `artifactJson()` (the JSON shape the model produces) and `runtimeValue()`. The runner fails if a fixture's JSON and the model disagree. `intFixture` and `textFixture` cover plain values.

## Driving scenarios yourself

The generated file exports `ownership`, `retrieve`, `artifact()`, `driver(implementation)` and `asyncDriver(implementation)`, so you can run a scenario without `refineAll`. The runtime provides `refineScenario` and `refineScenarioAsync` for a `PrimitiveDriver`, `runRefinedActions` and `runRefinedActionsAsync` for an action-at-a-time driver, and `RefinementSession`, the step-by-step reducer under them. The [shared corpus test](../../bindings/typescript/corpus/corpus.test.ts) uses `refineScenario` directly.

## Differences from the Rust and Go runtimes

1. Both an asynchronous and a synchronous runner exist for the generated adapter (`refineAll` and `refineAllSync`), and the runtime has `refineScenarioAsync` next to `refineScenario`, as Rust does. As in Rust, evaluation is synchronous; only the call into your code is awaited.
2. Integers are `bigint` and unbounded. Go reports an error when `iadd` or `isub` leaves the `i64` range, Rust panics in debug builds and wraps in release builds, and both reject an ITF number outside it; this runtime computes the exact result.
3. `compile --typescript` does not add a language to `new`. `new` scaffolds a Rust project, as it does for Go.
4. Artifact parse errors name the same fields but are worded by this runtime, where serde words them differently.
5. Errors are thrown as `RefinementError` rather than returned.
