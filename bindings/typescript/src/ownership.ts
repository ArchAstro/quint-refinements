import { compareStrings } from "./json.js";
import { fail } from "./error.js";

/**
 * A compile-time record: one implementation command and the Quint actions it
 * refines.
 *
 * `refines` is the ordered spec tape of one impl execution. Length 1 is a
 * normal command. Length N is one source command that takes N spec steps
 * without yielding (the only legal 1-to-N model).
 *
 * `aliases` are extra JSON names for a 1-step refine. They are forbidden when
 * `refines` is a sequence.
 *
 * `actions` is the legacy independent-name list (each name is its own 1-step
 * run). Prefer `refines` for new records.
 */
export interface OwnershipRecord {
  /** The stable identifier of the implementation command. */
  readonly primitive: string;
  /** The ordered model actions refined by one command execution. */
  readonly refines?: readonly string[];
  /** Alternate generated names for a one-step action. */
  readonly aliases?: readonly string[];
  /** Legacy independent action names retained for compatibility. */
  readonly actions?: readonly string[];
  /** The observation paths the primitive makes available. */
  readonly observations?: readonly string[];
  /** The expression dependencies the primitive can retrieve. */
  readonly retrieve?: readonly string[];
}

/** One package's exported ownership records. */
export interface OwnershipTable {
  /** The package or module that exports the records. */
  readonly owner: string;
  readonly descriptors: readonly OwnershipRecord[];
}

/** A runtime copy of an ownership record with an owning package name. */
export interface OwnershipDescriptor {
  readonly owner: string;
  readonly primitive: string;
  readonly refines: readonly string[];
  readonly aliases: readonly string[];
  /** Every action name the record covers, de-duplicated. */
  readonly actions: readonly string[];
  readonly observations: readonly string[];
  readonly retrieve: readonly string[];
}

function coverageActions(record: OwnershipRecord): string[] {
  const names = new Set<string>();
  for (const group of [record.refines ?? [], record.aliases ?? [], record.actions ?? []]) {
    for (const name of group) {
      names.add(name);
    }
  }
  return [...names];
}

/** Validates explicit ownership tables and sorts their records by primitive identifier. */
export function collectOwnershipRecords(...tables: readonly OwnershipTable[]): OwnershipDescriptor[] {
  const descriptors: OwnershipDescriptor[] = [];
  for (const table of tables) {
    for (const record of table.descriptors) {
      if (record.primitive.trim() === "") {
        return fail(`ownership record owned by ${table.owner} has an empty primitive ID`);
      }
      if ((record.refines?.length ?? 0) > 1 && (record.aliases?.length ?? 0) > 0) {
        return fail(`primitive ${record.primitive} refines a sequence and cannot declare aliases`);
      }
      descriptors.push({
        owner: table.owner,
        primitive: record.primitive,
        refines: [...(record.refines ?? [])],
        aliases: [...(record.aliases ?? [])],
        actions: coverageActions(record),
        observations: [...(record.observations ?? [])],
        retrieve: [...(record.retrieve ?? [])],
      });
    }
  }
  descriptors.sort((a, b) => compareStrings(a.primitive, b.primitive));
  for (let index = 1; index < descriptors.length; index += 1) {
    if (descriptors[index - 1]!.primitive === descriptors[index]!.primitive) {
      return fail(`primitive ID ${descriptors[index]!.primitive} is declared more than once`);
    }
  }
  return descriptors;
}
