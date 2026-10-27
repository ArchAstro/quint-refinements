import assert from "node:assert/strict";
import test from "node:test";

import {
  collectOwnedActionSnapshots,
  collectOwnershipRecords,
  formatActions,
  int,
  parseConformanceArtifact,
  schedulePrimitiveRuns,
  type OwnershipDescriptor,
} from "../dist/index.js";
import { minimalArtifact, noState } from "./helpers.ts";

const descriptor = (primitive: string, refines: string[], aliases: string[] = []): OwnershipDescriptor => ({
  owner: "test",
  primitive,
  refines,
  aliases,
  actions: [...refines, ...aliases],
  observations: [],
  retrieve: [],
});

test("consecutive owned actions schedule one compound tape", () => {
  const steps = ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"];
  assert.deepEqual(schedulePrimitiveRuns(steps, [descriptor("gateway.delivery.enqueue", steps)]), [
    { primitive: "gateway.delivery.enqueue", ownedActions: steps },
  ]);
});

test("alias actions schedule one evidence each", () => {
  const ownership = [
    descriptor("gateway.connection.register", ["openConnection"], ["openConnectionForRuntimeOwner"]),
    descriptor("gateway.connection.receive_hello", ["receiveHello"]),
  ];
  const runs = schedulePrimitiveRuns(["openConnection", "receiveHello", "openConnectionForRuntimeOwner"], ownership);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[2], { primitive: "gateway.connection.register", ownedActions: ["openConnectionForRuntimeOwner"] });
});

test("scheduling fails closed", () => {
  const compound = descriptor("p", ["a", "b", "c"]);
  const cases: [name: string, actions: string[], ownership: OwnershipDescriptor[], want: string][] = [
    ["partial compound", ["a", "b"], [compound], "primitive p JSON actions [a, b] are not the owned sequence [a, b, c]"],
    ["unowned", ["z"], [compound], "JSON action z has no ownership record"],
    ["double owner", ["x"], [descriptor("p1", ["x"]), descriptor("p2", ["x"])], "JSON action x is owned by multiple primitives (p1, p2)"],
  ];
  for (const [name, actions, ownership, want] of cases) {
    assert.throws(() => schedulePrimitiveRuns(actions, ownership), { message: want }, name);
  }
});

test("legacy action lists are independent one-step runs", () => {
  const legacy: OwnershipDescriptor = { ...descriptor("p", []), actions: ["a", "b"] };
  assert.equal(schedulePrimitiveRuns(["a", "b"], [legacy]).length, 2);
});

test("ownership aggregation validates and sorts", () => {
  assert.throws(() => collectOwnershipRecords({ owner: "o", descriptors: [{ primitive: "  " }] }), {
    message: "ownership record owned by o has an empty primitive ID",
  });
  assert.throws(
    () => collectOwnershipRecords({ owner: "o", descriptors: [{ primitive: "p", refines: ["a", "b"], aliases: ["x"] }] }),
    { message: "primitive p refines a sequence and cannot declare aliases" },
  );
  assert.throws(
    () => collectOwnershipRecords({ owner: "o", descriptors: [{ primitive: "p" }] }, { owner: "q", descriptors: [{ primitive: "p" }] }),
    { message: "primitive ID p is declared more than once" },
  );
  const [first, second] = collectOwnershipRecords({
    owner: "o",
    descriptors: [{ primitive: "b", refines: ["x"], aliases: ["y"], actions: ["x", "z"] }, { primitive: "a" }],
  });
  assert.equal(first?.primitive, "a");
  assert.deepEqual(second?.actions, ["x", "y", "z"], "coverage names are de-duplicated");
});

test("a compound tape must return one evidence per owned action", () => {
  const artifact = parseConformanceArtifact(minimalArtifact);
  const steps = ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"];
  const ownership = [descriptor("gateway.delivery.enqueue", steps)];
  const scenario = artifact.scenarios[0]!;
  assert.throws(() => collectOwnedActionSnapshots(scenario, noState, ownership, () => [noState]), {
    message: "primitive gateway.delivery.enqueue owns 3 actions but returned 1 evidence snapshots",
  });
  const snapshots = collectOwnedActionSnapshots(scenario, noState, ownership, (_, owned) => owned.map(() => noState));
  assert.equal(snapshots.length, 4);
});

test("a resolved action renders like Rust's Debug", () => {
  assert.equal(
    formatActions([{ name: "a", arguments: [int(1)] }, { name: "b", arguments: [] }]),
    '[ResolvedAction { name: "a", arguments: [Int(1)] }, ResolvedAction { name: "b", arguments: [] }]',
  );
});

test("an empty primitive id is judged by Unicode White_Space, as Rust's trim does", () => {
  assert.throws(() => collectOwnershipRecords({ owner: "o", descriptors: [{ primitive: "\u0085" }] }), /empty primitive ID/);
  assert.equal(collectOwnershipRecords({ owner: "o", descriptors: [{ primitive: "﻿" }] }).length, 1);
});
