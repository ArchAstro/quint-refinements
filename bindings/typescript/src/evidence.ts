import type { RuntimeValue } from "./value.js";

/**
 * Resolves domain-specific names and calls used by refinement expressions.
 *
 * The shared evaluator owns the normalized expression grammar. An
 * implementation exposes only evidence that is specific to one runtime
 * scenario family. A snapshot returned from an implementation must not change
 * after it is returned: the runner keeps every one of them for the whole
 * scenario.
 */
export interface Evidence {
  /**
   * Resolves a generated name such as `"state"` to its observed value, or
   * returns `undefined` when this evidence does not own the name.
   */
  resolveName(name: string): RuntimeValue | undefined;
  /**
   * Resolves an optional domain-specific call. Return `undefined` when this
   * evidence does not handle the operator, which falls through to the built-in
   * evaluation.
   */
  resolveCall?(operator: string, args: readonly RuntimeValue[]): RuntimeValue | undefined;
}

/** The common evidence: it answers only the name `"state"`. */
export function stateEvidence(state: RuntimeValue): Evidence {
  return {
    resolveName: name => (name === "state" ? state : undefined),
  };
}
