/**
 * The fail-closed error from parsing, ownership aggregation, fixture
 * validation, or evaluation. Its message matches the Rust and Go runtimes'
 * diagnostics character for character.
 */
export class RefinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinementError";
  }
}

/** Throws a {@link RefinementError}; the return type lets callers use it in expressions. */
export function fail(message: string): never {
  throw new RefinementError(message);
}

/** The diagnostic text of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
