import { fail } from "./error.js";
import { debug, type BoolValue, type IntValue, type ListValue, type RecordValue, type RuntimeValue, type TextValue } from "./value.js";

// Typed accessors for the values an implementation receives, such as an
// action's arguments or the scenario's initial state. Each one fails with a
// RefinementError that shows the value it did not expect.

function expected(kind: string, value: RuntimeValue | undefined): never {
  return fail(`expected ${kind}, got ${value === undefined ? "nothing" : debug(value)}`);
}

export function asBool(value: RuntimeValue | undefined): boolean {
  return value?.kind === "bool" ? (value as BoolValue).value : expected("a boolean", value);
}

/** Reads an integer as a `bigint`; Quint integers are unbounded. */
export function asInt(value: RuntimeValue | undefined): bigint {
  return value?.kind === "int" ? (value as IntValue).value : expected("an integer", value);
}

export function asText(value: RuntimeValue | undefined): string {
  return value?.kind === "text" ? (value as TextValue).value : expected("text", value);
}

export function asList(value: RuntimeValue | undefined): readonly RuntimeValue[] {
  return value?.kind === "list" ? (value as ListValue).items : expected("a list", value);
}

export function asRecord(value: RuntimeValue | undefined): ReadonlyMap<string, RuntimeValue> {
  return value?.kind === "record" ? (value as RecordValue).fields : expected("a record", value);
}

/** Reads one field of a record value, failing when the field is missing. */
export function fieldOf(value: RuntimeValue | undefined, name: string): RuntimeValue {
  return asRecord(value).get(name) ?? fail(`record has no field ${name}: ${debug(value!)}`);
}
