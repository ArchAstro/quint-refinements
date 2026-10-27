// A worked example: a client COMMIT is one TypeScript method, while the Quint
// model still has three spec steps (write PREPARE, flush the WAL, write COMMIT).
//
// Everything that connects this file to model.qnt lives in
// generated_refinement.ts, which `quint-refinements compile --typescript`
// derives from the model.
import {
  asBool,
  asList,
  asText,
  bool,
  fieldOf,
  FixtureTable,
  list,
  record,
  RefinementError,
  stateEvidence,
  text,
  type Evidence,
  type QuintFixture,
  type RuntimeValue,
} from "quint-refinements/runtime";

import type { Implementation } from "./generated_refinement.ts";

/** The transaction statuses. They own the Quint `Status` constructors. */
export const statuses = ["Idle", "Open", "Prepared", "Committed", "Aborted"] as const;
export type Status = (typeof statuses)[number];

function statusFromTag(tag: string): Status {
  const status = statuses.find(candidate => candidate === tag);
  if (status === undefined) {
    throw new RefinementError(`unknown status ${tag}`);
  }
  return status;
}

function statusFixture(status: Status): QuintFixture {
  return {
    artifactJson: () => ({ tag: status, value: { "#tup": [] } }),
    runtimeValue: () => text(status),
  };
}

/** Makes the Quint `statuses` universe this module's `statuses`, not a parallel test twin. */
export function fixtureTable(): FixtureTable {
  return new FixtureTable("two_phase_commit").insertSet("statuses", ...statuses.map(statusFixture));
}

/** What the refinement checker may observe. */
export interface Snapshot {
  readonly status: Status;
  readonly wal: readonly string[];
  readonly flushed: boolean;
}

/** Reads a transaction record, such as a scenario's generated initial state. */
export function parseSnapshot(value: RuntimeValue): Snapshot {
  const status = fieldOf(value, "status");
  return {
    status: statusFromTag(status.kind === "variant" ? status.tag : asText(status)),
    wal: asList(fieldOf(value, "wal")).map(asText),
    flushed: asBool(fieldOf(value, "flushed")),
  };
}

function evidenceOf(snapshot: Snapshot): Evidence {
  return stateEvidence(
    record({
      status: text(snapshot.status),
      flushed: bool(snapshot.flushed),
      wal: list(snapshot.wal.map(text)),
    }),
  );
}

/**
 * An in-memory stand-in for a Postgres transaction's prepare, flush and commit
 * log. A method may declare fewer parameters than the generated interface
 * passes, so `begin()` and `abort()` ignore the scenario's (empty) arguments.
 */
export class Coordinator implements Implementation {
  protected status: Status;
  protected wal: string[];
  protected flushed: boolean;

  constructor(initial: Snapshot = { status: "Idle", wal: [], flushed: false }) {
    this.status = initial.status;
    this.wal = [...initial.wal];
    this.flushed = initial.flushed;
  }

  /** Builds a coordinator from a scenario's generated initial state. */
  static fromState(initial: RuntimeValue): Coordinator {
    return new Coordinator(parseSnapshot(initial));
  }

  /** A copy of the current observable state. */
  state(): Snapshot {
    return { status: this.status, wal: [...this.wal], flushed: this.flushed };
  }

  snapshot(): Evidence {
    return evidenceOf(this.state());
  }

  begin(): void {
    if (this.status !== "Idle") {
      throw new Error("begin requires Idle");
    }
    this.status = "Open";
  }

  protected prepare(): void {
    if (this.status !== "Open") {
      throw new Error("prepare requires Open");
    }
    this.status = "Prepared";
    this.wal.push("prepare");
    this.flushed = false;
  }

  protected flushWal(): void {
    if (this.status !== "Prepared" || this.flushed) {
      throw new Error("flush requires unflushed Prepared");
    }
    this.flushed = true;
  }

  protected commitPrepared(): void {
    if (this.status !== "Prepared" || !this.flushed) {
      throw new Error("commitPrepared requires flushed Prepared");
    }
    this.status = "Committed";
    this.wal.push("commit");
  }

  abort(): void {
    if (this.status !== "Open" && this.status !== "Prepared") {
      throw new Error("abort requires Open or Prepared");
    }
    this.status = "Aborted";
  }

  /**
   * One client COMMIT. Internally prepare, flush, commit: the 1-to-N tape
   * declared by `@primitive commit = [prepare, flushWal, commitPrepared]` in
   * the model. It returns one snapshot after each of the three steps.
   */
  commit(): readonly Evidence[] {
    this.prepare();
    const prepared = this.snapshot();
    this.flushWal();
    const flushed = this.snapshot();
    this.commitPrepared();
    return [prepared, flushed, this.snapshot()];
  }
}
