import assert from "node:assert/strict";
import test from "node:test";

import { Coordinator, fixtureTable, parseSnapshot } from "./coordinator.ts";
import { refineAll, refineAllSync } from "./generated_refinement.ts";

const options = { fixtures: fixtureTable };

test("commitRun refines the model with one commit() owning three actions", () => {
  const results = refineAllSync(Coordinator.fromState, options);
  assert.deepEqual(
    results.map(result => [result.scenario, result.evaluatedObligations]),
    [
      ["two_phase_commit.commitRun", 14],
      ["two_phase_commit.abortBeforePrepareRun", 5],
    ],
  );
  assert.deepEqual(results[0]?.implementation.state(), { status: "Committed", wal: ["prepare", "commit"], flushed: true });
});

test("the async runner reports the same obligations", async () => {
  const results = await refineAll(Coordinator.fromState, options);
  assert.deepEqual(
    results.map(result => result.evaluatedObligations),
    [14, 5],
  );
});

test("the model's own constants are used when no fixtures are supplied", () => {
  assert.equal(refineAllSync(Coordinator.fromState)[0]?.evaluatedObligations, 14);
});

/** Commits without ever flushing the WAL: durability is lost. */
class EarlyCommit extends Coordinator {
  override commit() {
    this.status = "Committed";
    this.wal.push("prepare", "commit");
    const done = this.snapshot();
    return [done, done, done];
  }
}

test("a commit that skips the flush is reported as a divergence", () => {
  assert.throws(() => refineAllSync(initial => new EarlyCommit(parseSnapshot(initial)), options), {
    message: 'two_phase_commit.commitRun:prepare next: assign state diverged at state.status expected Text("Prepared"), observed Text("Committed")',
  });
});

test("a status the production type does not know fails the fixture check", () => {
  const drifted = fixtureTable();
  drifted.insertSet("statuses", { artifactJson: () => ({ tag: "Idle", value: { "#tup": [] } }), runtimeValue: () => ({ kind: "text", value: "Idle" }) });
  assert.throws(() => refineAllSync(Coordinator.fromState, { fixtures: () => drifted }), /fixture statuses JSON diverged/);
});
