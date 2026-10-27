import { RefinementError } from "./error.js";

/**
 * The form of an object whose methods may each return a promise as well as a
 * plain value. Generated adapters use it so one `Implementation` interface
 * describes both a synchronous and an asynchronous implementation.
 */
export type MaybeAsync<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : T[K];
};

/** Reports whether `value` is a promise or another thenable. */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Returns `value` unchanged, or throws when it is a promise. The synchronous
 * runners use it so an asynchronous method cannot slip past them: an unawaited
 * promise would let the runner take its snapshot before the action finished.
 */
export function ensureSynchronous<T>(method: string, value: T): T {
  if (isPromiseLike(value)) {
    throw new RefinementError(`${method} returned a promise; use the asynchronous runner (refineAll) for an asynchronous implementation`);
  }
  return value;
}
