import {
  createItfActionNextHook,
  defineConformanceApp,
} from "../../../../packages/compiler/generate.mjs";

const retrieve = new Set([
  "name:state",
  "name:statuses",
  "operator:append",
  "operator:assign",
  "operator:contains",
  "operator:eq",
  "operator:field",
  "operator:or",
  "operator:with",
  "path:state.flushed",
  "path:state.status",
  "path:state.wal",
]);

export const twoPhaseCommitApp = defineConformanceApp({
  actions: [
    "abort",
    "begin",
    "commitPrepared",
    "flushWal",
    "prepare",
  ],
  capabilities: ["txn.commit"],
  expressionOperators: ["eq", "field"],
  expressionNames: ["Aborted", "Committed", "state"],
  modelOnlyNames: [],
  modelOnlyOperators: [],
  initializers: ["init"],
  fixtureImports: [],
  requireObserve: true,
  attachActionNext: createItfActionNextHook(),
  runtimeObservationDependencyDigest:
    "sha256:4308586e6c38b007053c521d621313ce578e4f3d70e165f29d0f18ae945c5c4e",
  retrieveForCapabilities: () => new Set(retrieve),
  actionRetrieveForCapabilities: () => new Set(retrieve),
  sources: () => [{
    source: "model.qnt",
    module: "two_phase_commit",
    init: "init",
    step: "begin",
  }],
});
