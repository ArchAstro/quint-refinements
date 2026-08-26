import {
  createItfActionNextHook,
  defineConformanceApp,
} from "@archastro/quint-refinements/harness/generate.mjs";

const retrieve = new Set([
  "name:state",
  "operator:assign",
  "operator:eq",
  "operator:field",
  "operator:igt",
  "operator:igte",
  "operator:isub",
  "path:state.balance",
]);

export const bankApp = defineConformanceApp({
  actions: ["withdraw"],
  capabilities: ["bank.withdraw"],
  expressionOperators: ["eq", "field"],
  expressionNames: ["state"],
  modelOnlyNames: [],
  modelOnlyOperators: [],
  initializers: ["init"],
  fixtureImports: [],
  requireObserve: true,
  attachActionNext: createItfActionNextHook(),
  runtimeObservationDependencyDigest:
    "sha256:54f2836ccff5e30c0e7a95fc7b7c711d1c4e567d4dd05074d6aa31776ed268cc",
  retrieveForCapabilities: () => new Set(retrieve),
  actionRetrieveForCapabilities: () => new Set(retrieve),
  sources: () => [{
    source: "bank.qnt",
    module: "bank",
    init: "init",
    step: "withdraw",
  }],
});
