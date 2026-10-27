# quint-refinements for TypeScript

Check a TypeScript implementation against a [Quint](https://quint.sh/) model.

This is the runtime. It drives your implementation through scenarios generated
from the model and evaluates every generated guard and next-state obligation
against the snapshots your code returns. It reads the same schema-v2 artifact
as the Rust crate and the Go module, and reports the same obligations and the
same divergence messages. It has no dependencies, and Quint integers are
`bigint`.

It ships inside the `quint-refinements` npm package, as the subpath
`quint-refinements/runtime`, so the compiler and the runtime are one install:

```console
npm install --save-dev quint-refinements
npx quint-refinements compile model.qnt --typescript refinement/generated.ts
```

Then implement the generated `Implementation` interface for your own type:

```ts
import { refineAll } from "./refinement/generated.ts";

const results = await refineAll(Bank.fromState); // Bank.fromState(initial: RuntimeValue): Bank
for (const result of results) {
  console.log(`${result.scenario} refined ${result.evaluatedObligations} obligations`);
}
```

A divergence is thrown as a `RefinementError`. The npm package and the other
runtimes release under one version. The repository
[documentation](https://archastro.github.io/quint-refinements/reference/typescript)
covers the generated interface, values, snapshots and fixtures.

To drive scenarios yourself, use `refineScenario`, `refineScenarioAsync`,
`runRefinedActions`, or a step-by-step `RefinementSession` with the generated
`ownership` and `retrieve` tables.

## Layout

1. `src/` is the runtime. `npm run build:runtime` compiles it to `dist/`
   (`.js` and `.d.ts`), which the package exports.
2. `test/` has one test file per runtime module, run with `node --test`.
3. `corpus/` runs the shared cases in `conformance/cases` against the examples
   in `examples/typescript`.

Requires Node.js 22 or newer.
