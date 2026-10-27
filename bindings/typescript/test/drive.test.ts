import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  collectOwnershipRecords,
  FixtureTable,
  int,
  parseConformanceArtifact,
  record,
  RefinementSession,
  refineScenario,
  refineScenarioAsync,
  resolveActionPlan,
  runRefinedActions,
  runRefinedActionsAsync,
  stateEvidence,
  type ArtifactScenario,
  type Evidence,
  type ResolvedAction,
} from "../dist/index.js";

// The bank model: balance 10, then withdraw(4), then assert balance == 6.
const artifact = parseConformanceArtifact(
  readFileSync(new URL("../../../conformance/cases/bank_withdraw/artifact.json", import.meta.url), "utf8"),
);
const scenario: ArtifactScenario = artifact.scenarios[0]!;
const ownership = collectOwnershipRecords({
  owner: "test",
  descriptors: [{ primitive: "bank.withdraw", refines: ["withdraw"] }],
});
const retrieve = [
  "name:state",
  "operator:Rec",
  "operator:assign",
  "operator:eq",
  "operator:field",
  "operator:igt",
  "operator:igte",
  "operator:isub",
  "path:state.balance",
];
const fixtures = FixtureTable.fromArtifact("bank", artifact);
const bank = (balance: number): Evidence => stateEvidence(record({ balance: int(balance) }));

test("refineScenario walks the scenario through a primitive driver and counts obligations", () => {
  const calls: ResolvedAction[][] = [];
  const evaluated = refineScenario(scenario, bank(10), ownership, retrieve, fixtures, {
    runPrimitive(primitive, actions) {
      assert.equal(primitive, "bank.withdraw");
      calls.push([...actions]);
      return [bank(6)];
    },
  });
  assert.equal(evaluated, 3);
  assert.deepEqual(calls, [[{ name: "withdraw", arguments: [int(4)] }]]);
});

test("refineScenario reports the first divergence with the Rust and Go message", () => {
  assert.throws(
    () => refineScenario(scenario, bank(10), ownership, retrieve, fixtures, { runPrimitive: () => [bank(14)] }),
    { message: "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)" },
  );
});

test("a driver that returns the wrong number of snapshots is rejected", () => {
  assert.throws(() => refineScenario(scenario, bank(10), ownership, retrieve, fixtures, { runPrimitive: () => [] }), {
    message: "primitive bank.withdraw owns 1 actions but returned 0 evidence snapshots",
  });
});

test("the synchronous runner refuses a driver that returns a promise", () => {
  assert.throws(
    () =>
      refineScenario(scenario, bank(10), ownership, retrieve, fixtures, {
        runPrimitive: (() => Promise.resolve([bank(6)])) as never,
      }),
    { message: "primitive bank.withdraw returned a promise; use refineScenarioAsync" },
  );
});

test("refineScenarioAsync awaits each primitive and reports the same count and divergence", async () => {
  let running = 0;
  const driver = (balance: number) => ({
    async runPrimitive(): Promise<readonly Evidence[]> {
      running += 1;
      assert.equal(running, 1, "primitives run one at a time");
      await new Promise(resolve => setTimeout(resolve, 1));
      running -= 1;
      return [bank(balance)];
    },
  });
  assert.equal(await refineScenarioAsync(scenario, bank(10), ownership, retrieve, fixtures, driver(6)), 3);
  await assert.rejects(refineScenarioAsync(scenario, bank(10), ownership, retrieve, fixtures, driver(14)), {
    message: "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)",
  });
  // A synchronous driver is accepted too.
  assert.equal(await refineScenarioAsync(scenario, bank(10), ownership, retrieve, fixtures, { runPrimitive: () => [bank(6)] }), 3);
});

test("a scheduling failure surfaces before any primitive runs", () => {
  assert.throws(() => refineScenario(scenario, bank(10), [], retrieve, fixtures, { runPrimitive: () => assert.fail("must not run") }), {
    message: "JSON action withdraw has no ownership record",
  });
});

test("an initial snapshot that disagrees with the model's initial state is rejected", () => {
  assert.throws(() => refineScenario(scenario, bank(3), ownership, retrieve, fixtures, { runPrimitive: () => [bank(6)] }), {
    message: "bank.withdrawRun Rust fixture does not match Quint initial state: state.balance expected Int(10), observed Int(3)",
  });
});

test("resolveActionPlan evaluates every action's arguments up front", () => {
  assert.deepEqual(resolveActionPlan(scenario, bank(10), fixtures), [{ name: "withdraw", arguments: [int(4)] }]);
});

test("runRefinedActions merges sparse observations into the model's next state", () => {
  const run = runRefinedActions(scenario, bank(10), retrieve, fixtures, { runAction: () => bank(6) });
  assert.equal(run.evaluated, 3);
  assert.equal(run.snapshots.length, 2);
  // An observation that omits a runtime-owned field the action changed is rejected.
  assert.throws(() => runRefinedActions(scenario, bank(10), retrieve, fixtures, { runAction: () => stateEvidence(record()) }), {
    message: "bank.withdrawRun:withdraw state evidence: Rust action omitted changed runtime-owned field state.balance",
  });
  assert.throws(
    () => runRefinedActions(scenario, bank(10), retrieve, fixtures, { runAction: (() => Promise.resolve(bank(6))) as never }),
    { message: "action withdraw returned a promise; use runRefinedActionsAsync" },
  );
});

test("runRefinedActionsAsync drives the same session", async () => {
  const run = await runRefinedActionsAsync(scenario, bank(10), retrieve, fixtures, { runAction: async () => bank(6) });
  assert.equal(run.evaluated, 3);
  await assert.rejects(runRefinedActionsAsync(scenario, bank(10), retrieve, fixtures, { runAction: async () => bank(14) }), {
    message: "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)",
  });
});

test("a session enforces dispatch, record, dispatch, record", () => {
  const session = new RefinementSession(scenario, bank(10), retrieve, fixtures);
  assert.throws(() => session.record(bank(6)), { message: "cannot record Rust evidence without a dispatched generated action" });
  assert.throws(() => session.finish(), /stopped after 0 of 1 generated actions/);
  const action = session.nextAction();
  assert.deepEqual(action, { name: "withdraw", arguments: [int(4)] });
  assert.throws(() => session.nextAction(), { message: "record the preceding Rust action observation before requesting another action" });
  assert.throws(() => session.finish(), { message: "generated action was dispatched without a Rust observation" });
  session.record(bank(6));
  assert.equal(session.nextAction(), undefined);
  assert.equal(session.finish().evaluated, 3);
});
