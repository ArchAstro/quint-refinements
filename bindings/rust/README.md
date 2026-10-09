# quint-refinements

Check a Rust implementation against a [Quint](https://quint.sh/) model.

This crate is the runtime. It drives your implementation through scenarios
generated from the model and evaluates every generated guard and next-state
obligation against the snapshots your code returns.

Start with the compiler, which generates the scenarios and a typed adapter for
this crate:

```console
npx quint-refinements new my-check
cd my-check
cargo run
```

Then implement the generated `Implementation` trait for your own type:

```rust
mod generated_refinement;

use generated_refinement::{Implementation, refine_all};

fn main() {
    for result in refine_all::<Bank>().expect("Bank refines the model") {
        println!("{} refined {} obligations", result.scenario, result.evaluated_obligations);
    }
}
```

The crate and the `quint-refinements` npm package release under one version;
use matching versions. The repository
[README](https://github.com/ArchAstro/quint-refinements) covers the model
annotations, the tutorial, and the examples.

To drive scenarios yourself, use `refine_scenario`, `refine_scenario_async`,
or a step-by-step `RefinementSession` with the generated `OWNERSHIP` and
`RETRIEVE` tables.
