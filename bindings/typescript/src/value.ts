import { fail } from "./error.js";
import { compareStrings, type Json, type JsonObject, jsonString, parseJson, sortedKeys } from "./json.js";

/**
 * A normalized Quint value reconstructed from runtime-owned evidence. The
 * variants mirror the Rust and Go bindings:
 * `bool`, `int`, `text`, `set`, `list`, `tuple`, `map`, `record`, `variant`,
 * `absent` and `present`.
 *
 * Values are immutable; build them with the constructors in this module.
 * Unit variants of a Quint sum type (for example `Idle`) are `text` values
 * holding the constructor name. Quint integers are unbounded, so `int` holds a
 * `bigint`.
 */
export type RuntimeValue =
  | BoolValue
  | IntValue
  | TextValue
  | SetValue
  | ListValue
  | TupleValue
  | MapValue
  | RecordValue
  | VariantValue
  | AbsentValue
  | PresentValue;

export interface BoolValue {
  readonly kind: "bool";
  readonly value: boolean;
}

export interface IntValue {
  readonly kind: "int";
  readonly value: bigint;
}

export interface TextValue {
  readonly kind: "text";
  readonly value: string;
}

/** A set whose members are ordered and de-duplicated structurally. */
export interface SetValue {
  readonly kind: "set";
  readonly members: readonly RuntimeValue[];
}

export interface ListValue {
  readonly kind: "list";
  readonly items: readonly RuntimeValue[];
}

export interface TupleValue {
  readonly kind: "tuple";
  readonly items: readonly RuntimeValue[];
}

/** One key/value pair of a {@link MapValue}. */
export type MapEntry = readonly [key: RuntimeValue, value: RuntimeValue];

/** A map whose entries are ordered by key. Keys and values keep their Quint structure. */
export interface MapValue {
  readonly kind: "map";
  readonly entries: readonly MapEntry[];
}

/** A record. Iteration order is ascending by field name. */
export interface RecordValue {
  readonly kind: "record";
  readonly fields: ReadonlyMap<string, RuntimeValue>;
}

/** A tagged union value with a payload. */
export interface VariantValue {
  readonly kind: "variant";
  readonly tag: string;
  readonly value: RuntimeValue;
}

/** The Quint `Absent` option. */
export interface AbsentValue {
  readonly kind: "absent";
}

/** The Quint `Present(value)` option. */
export interface PresentValue {
  readonly kind: "present";
  readonly value: RuntimeValue;
}

export type RuntimeValueKind = RuntimeValue["kind"];

export const absent: AbsentValue = Object.freeze({ kind: "absent" });

export function bool(value: boolean): BoolValue {
  return { kind: "bool", value };
}

/** Builds an integer. A `number` must be a safe integer; use a `bigint` beyond that. */
export function int(value: bigint | number): IntValue {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return fail(`${value} is not a safe integer; pass a bigint`);
    }
    return { kind: "int", value: BigInt(value) };
  }
  return { kind: "int", value };
}

export function text(value: string): TextValue {
  return { kind: "text", value };
}

export function list(items: Iterable<RuntimeValue> = []): ListValue {
  return { kind: "list", items: [...items] };
}

export function tuple(items: Iterable<RuntimeValue> = []): TupleValue {
  return { kind: "tuple", items: [...items] };
}

/** Builds a set: members are ordered and de-duplicated structurally. */
export function set(members: Iterable<RuntimeValue> = []): SetValue {
  const sorted = [...members].sort(compare);
  const unique: RuntimeValue[] = [];
  for (const member of sorted) {
    const previous = unique[unique.length - 1];
    if (previous === undefined || compare(previous, member) !== 0) {
      unique.push(member);
    }
  }
  return { kind: "set", members: unique };
}

/** Builds a normalized set of text values. */
export function textSet(values: Iterable<string>): SetValue {
  return set([...values].map(text));
}

/** Builds a map. When a key repeats, the last entry wins. */
export function map(entries: Iterable<MapEntry> = []): MapValue {
  // Array.prototype.sort is stable, so equal keys keep their input order.
  const sorted = [...entries].sort((a, b) => compare(a[0], b[0]));
  const result: MapEntry[] = [];
  for (const entry of sorted) {
    const previous = result[result.length - 1];
    if (previous !== undefined && compare(previous[0], entry[0]) === 0) {
      result[result.length - 1] = entry;
    } else {
      result.push(entry);
    }
  }
  return { kind: "map", entries: result };
}

/** Builds a record from a plain object or from `[name, value]` pairs. */
export function record(
  fields: Readonly<Record<string, RuntimeValue>> | Iterable<readonly [string, RuntimeValue]> = {},
): RecordValue {
  const pairs: (readonly [string, RuntimeValue])[] =
    Symbol.iterator in fields
      ? [...(fields as Iterable<readonly [string, RuntimeValue]>)]
      : Object.entries(fields as Readonly<Record<string, RuntimeValue>>);
  pairs.sort((a, b) => compareStrings(a[0], b[0]));
  return { kind: "record", fields: new Map(pairs) };
}

export function variant(tag: string, value: RuntimeValue): VariantValue {
  return { kind: "variant", tag, value };
}

export function present(value: RuntimeValue): PresentValue {
  return { kind: "present", value };
}

const ranks: Record<RuntimeValueKind, number> = {
  bool: 0,
  int: 1,
  text: 2,
  set: 3,
  list: 4,
  tuple: 5,
  map: 6,
  record: 7,
  variant: 8,
  absent: 9,
  present: 10,
};

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSequences(left: readonly RuntimeValue[], right: readonly RuntimeValue[]): number {
  for (let index = 0; index < left.length && index < right.length; index += 1) {
    const result = compare(left[index]!, right[index]!);
    if (result !== 0) {
      return result;
    }
  }
  return compareNumbers(left.length, right.length);
}

/**
 * Totally orders runtime values exactly as the Rust binding's derived `Ord`
 * does: by variant (bool, int, text, set, list, tuple, map, record, variant,
 * absent, present), then by content. Sets, maps and folds iterate in this
 * order, which keeps results identical across bindings.
 */
export function compare(left: RuntimeValue, right: RuntimeValue): number {
  if (left.kind !== right.kind) {
    return compareNumbers(ranks[left.kind], ranks[right.kind]);
  }
  switch (left.kind) {
    case "bool":
      return compareNumbers(Number(left.value), Number((right as BoolValue).value));
    case "int": {
      const other = (right as IntValue).value;
      return left.value < other ? -1 : left.value > other ? 1 : 0;
    }
    case "text":
      return compareStrings(left.value, (right as TextValue).value);
    case "set":
      return compareSequences(left.members, (right as SetValue).members);
    case "list":
      return compareSequences(left.items, (right as ListValue).items);
    case "tuple":
      return compareSequences(left.items, (right as TupleValue).items);
    case "map": {
      const other = (right as MapValue).entries;
      for (let index = 0; index < left.entries.length && index < other.length; index += 1) {
        const a = left.entries[index]!;
        const b = other[index]!;
        const result = compare(a[0], b[0]) || compare(a[1], b[1]);
        if (result !== 0) {
          return result;
        }
      }
      return compareNumbers(left.entries.length, other.length);
    }
    case "record": {
      const a = [...left.fields];
      const b = [...(right as RecordValue).fields];
      for (let index = 0; index < a.length && index < b.length; index += 1) {
        const result = compareStrings(a[index]![0], b[index]![0]) || compare(a[index]![1], b[index]![1]);
        if (result !== 0) {
          return result;
        }
      }
      return compareNumbers(a.length, b.length);
    }
    case "variant": {
      const other = right as VariantValue;
      return compareStrings(left.tag, other.tag) || compare(left.value, other.value);
    }
    case "absent":
      return 0;
    case "present":
      return compare(left.value, (right as PresentValue).value);
  }
}

/** Structural equality, the same relation as Rust's `==`. */
export function equal(left: RuntimeValue, right: RuntimeValue): boolean {
  return compare(left, right) === 0;
}

function search<T>(items: readonly T[], target: RuntimeValue, keyOf: (item: T) => RuntimeValue): { found: boolean; index: number } {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const result = compare(keyOf(items[middle]!), target);
    if (result === 0) {
      return { found: true, index: middle };
    }
    if (result < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return { found: false, index: low };
}

/** Reports whether the set holds `member`. */
export function setContains(value: SetValue, member: RuntimeValue): boolean {
  return search(value.members, member, item => item).found;
}

/** Looks up a map key. */
export function mapGet(value: MapValue, key: RuntimeValue): RuntimeValue | undefined {
  const { found, index } = search(value.entries, key, entry => entry[0]);
  return found ? value.entries[index]![1] : undefined;
}

/** Returns a copy of `value` with `key` bound to `entry`. */
export function mapWith(value: MapValue, key: RuntimeValue, entry: RuntimeValue): MapValue {
  const { found, index } = search(value.entries, key, item => item[0]);
  const entries = [...value.entries];
  if (found) {
    entries[index] = [key, entry];
  } else {
    entries.splice(index, 0, [key, entry]);
  }
  return { kind: "map", entries };
}

/** Returns a copy of `value` with `name` set to `entry`. */
export function recordWith(value: RecordValue, name: string, entry: RuntimeValue): RecordValue {
  return record([...value.fields, [name, entry]]);
}

/** The field names of a record in ascending order. */
export function recordKeys(value: RecordValue): string[] {
  return [...value.fields.keys()];
}

/** Rust's `{:?}` quoting for strings. */
export function debugString(value: string): string {
  let out = '"';
  for (const char of value) {
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        out += /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u.test(char) && !/^\p{Grapheme_Extend}$/u.test(char)
          ? char
          : `\\u{${char.codePointAt(0)!.toString(16)}}`;
    }
  }
  return `${out}"`;
}

function debugList(values: readonly RuntimeValue[]): string {
  return `[${values.map(debug).join(", ")}]`;
}

/** Renders a list of values in Rust's `{:?}` notation, as divergence messages do. */
export function debugValues(values: readonly RuntimeValue[]): string {
  return debugList(values);
}

/** Renders strings in Rust's `{:?}` notation: `["a", "b"]`. */
export function debugStrings(values: readonly string[]): string {
  return `[${values.map(debugString).join(", ")}]`;
}

/**
 * Renders a value in the same notation as Rust's `Debug` output, so
 * divergence messages read identically in every binding.
 */
export function debug(value: RuntimeValue): string {
  switch (value.kind) {
    case "bool":
      return `Bool(${value.value})`;
    case "int":
      return `Int(${value.value})`;
    case "text":
      return `Text(${debugString(value.value)})`;
    case "set":
      return `Set({${value.members.map(debug).join(", ")}})`;
    case "list":
      return `List(${debugList(value.items)})`;
    case "tuple":
      return `Tuple(${debugList(value.items)})`;
    case "map":
      return `Map({${value.entries.map(([key, entry]) => `${debug(key)}: ${debug(entry)}`).join(", ")}})`;
    case "record":
      return `Record({${[...value.fields].map(([key, entry]) => `${debugString(key)}: ${debug(entry)}`).join(", ")}})`;
    case "variant":
      return `Variant { tag: ${debugString(value.tag)}, value: ${debug(value.value)} }`;
    case "absent":
      return "Absent";
    case "present":
      return `Present(${debug(value.value)})`;
  }
}

function decodeArray(value: Json | undefined, kind: string): RuntimeValue[] {
  if (!Array.isArray(value)) {
    return fail(`ITF ${kind} is not an array`);
  }
  return (value as readonly Json[]).map(fromItfJson);
}

function bigintFromText(value: string): bigint {
  if (!/^[+-]?[0-9]+$/.test(value)) {
    return fail(`ITF #bigint is not an integer: ${value}`);
  }
  return BigInt(value.replace(/^\+/, ""));
}

function fromItfObject(object: JsonObject): RuntimeValue {
  const bigint = object["#bigint"];
  if (bigint !== undefined) {
    if (typeof bigint !== "string") {
      return fail("ITF #bigint is not text");
    }
    return int(bigintFromText(bigint));
  }
  if (object["#tup"] !== undefined) {
    return tuple(decodeArray(object["#tup"], "#tup"));
  }
  if (object["#set"] !== undefined) {
    return set(decodeArray(object["#set"], "#set"));
  }
  const entries = object["#map"];
  if (entries !== undefined) {
    if (!Array.isArray(entries)) {
      return fail("ITF #map is not an array");
    }
    const decoded: MapEntry[] = [];
    for (const entry of entries as readonly Json[]) {
      if (!Array.isArray(entry)) {
        return fail("ITF #map entry is not an array");
      }
      const pair = entry as readonly Json[];
      if (pair.length !== 2) {
        return fail("ITF #map entry is not a key/value pair");
      }
      decoded.push([fromItfJson(pair[0]!), fromItfJson(pair[1]!)]);
    }
    return map(decoded);
  }
  const keys = Object.keys(object);
  if (keys.length === 2 && object["tag"] !== undefined && object["value"] !== undefined) {
    const tag = object["tag"];
    if (typeof tag !== "string") {
      return fail("ITF variant tag is not text");
    }
    const payload = fromItfJson(object["value"]);
    if (tag === "Absent") {
      return absent;
    }
    if (tag === "Present") {
      return present(payload);
    }
    if (payload.kind === "tuple" && payload.items.length === 0) {
      return text(tag);
    }
    return variant(tag, payload);
  }
  const fields: [string, RuntimeValue][] = [];
  for (const key of sortedKeys(object)) {
    if (key === "#meta" || key.startsWith("__")) {
      continue;
    }
    fields.push([key, fromItfJson(object[key]!)]);
  }
  return record(fields);
}

/**
 * Decodes an ITF value (as parsed by {@link parseJson}) without collapsing
 * maps, records, tuples, sets or variants into one another. Plain `number`s are
 * accepted when they are safe integers.
 */
export function fromItfJson(value: Json): RuntimeValue {
  if (value === null) {
    return fail("ITF null has no Quint runtime value");
  }
  switch (typeof value) {
    case "boolean":
      return bool(value);
    case "string":
      return text(value);
    case "bigint":
      return int(value);
    case "number":
      // The parser yields a number only for a literal with a fraction or exponent.
      return fail(`ITF number is outside normalized integer range: ${jsonString(value)}`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return list((value as readonly Json[]).map(fromItfJson));
  }
  return fromItfObject(value as JsonObject);
}

/** Decodes Quint's Informal Trace Format JSON text. */
export function fromItfText(source: string): RuntimeValue {
  let decoded: Json;
  try {
    decoded = parseJson(source);
  } catch (error) {
    return fail(`invalid ITF JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fromItfJson(decoded);
}
