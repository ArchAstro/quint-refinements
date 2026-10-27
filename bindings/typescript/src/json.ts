import { fail, RefinementError } from "./error.js";

/**
 * A decoded JSON value. Integer literals decode to `bigint`, so numbers beyond
 * 2^53 survive; any other number decodes to `number`.
 */
export type Json = null | boolean | string | number | bigint | readonly Json[] | JsonObject;

/** A decoded JSON object. It has no prototype, so `__proto__` is an ordinary key. */
export interface JsonObject {
  readonly [key: string]: Json;
}

/** Orders strings by code point, which is also UTF-8 byte order (Rust's `str` order). */
export function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done === true || y.done === true) {
      return x.done === true && y.done === true ? 0 : x.done === true ? -1 : 1;
    }
    if (x.value !== y.value) {
      return x.value.codePointAt(0)! < y.value.codePointAt(0)! ? -1 : 1;
    }
  }
}

/** Keys of a decoded object in byte order. */
export function sortedKeys(object: JsonObject): string[] {
  return Object.keys(object).sort(compareStrings);
}

const whitespace = new Set([" ", "\t", "\n", "\r"]);

class Parser {
  private position = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parseDocument(): Json {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.position < this.source.length) {
      throw this.error("trailing characters after JSON document");
    }
    return value;
  }

  private error(message: string): RefinementError {
    return new RefinementError(`${message} at offset ${this.position}`);
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && whitespace.has(this.source[this.position]!)) {
      this.position += 1;
    }
  }

  private parseValue(): Json {
    this.skipWhitespace();
    const char = this.source[this.position];
    switch (char) {
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      case undefined:
        throw this.error("unexpected end of JSON input");
      default:
        if (char === "-" || (char >= "0" && char <= "9")) {
          return this.parseNumber();
        }
        throw this.error(`unexpected character ${JSON.stringify(char)}`);
    }
  }

  private parseLiteral(text: string, value: Json): Json {
    if (!this.source.startsWith(text, this.position)) {
      throw this.error("invalid literal");
    }
    this.position += text.length;
    return value;
  }

  private parseNumber(): Json {
    const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.source.slice(this.position, this.position + 400));
    if (match === null) {
      throw this.error("invalid number");
    }
    this.position += match[0].length;
    if (match[1] === undefined && match[2] === undefined) {
      return BigInt(match[0]);
    }
    return Number(match[0]);
  }

  private parseString(): string {
    this.position += 1;
    let out = "";
    let start = this.position;
    for (;;) {
      const char = this.source[this.position];
      if (char === undefined) {
        throw this.error("unterminated string");
      }
      if (char === '"') {
        out += this.source.slice(start, this.position);
        this.position += 1;
        return out;
      }
      if (char < " ") {
        throw this.error("control character in string");
      }
      if (char === "\\") {
        out += this.source.slice(start, this.position);
        out += this.parseEscape();
        start = this.position;
      } else {
        this.position += 1;
      }
    }
  }

  private parseEscape(): string {
    const escape = this.source[this.position + 1];
    this.position += 2;
    switch (escape) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const digits = this.source.slice(this.position, this.position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
          throw this.error("invalid unicode escape");
        }
        this.position += 4;
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
      default:
        throw this.error("invalid escape");
    }
  }

  private parseArray(): Json {
    this.position += 1;
    const items: Json[] = [];
    this.skipWhitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return items;
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const char = this.source[this.position];
      this.position += 1;
      if (char === "]") {
        return items;
      }
      if (char !== ",") {
        this.position -= 1;
        throw this.error("expected `,` or `]`");
      }
    }
  }

  private parseObject(): Json {
    this.position += 1;
    const object: Record<string, Json> = Object.create(null) as Record<string, Json>;
    this.skipWhitespace();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return object;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.position] !== '"') {
        throw this.error("expected a string key");
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.source[this.position] !== ":") {
        throw this.error("expected `:`");
      }
      this.position += 1;
      object[key] = this.parseValue();
      this.skipWhitespace();
      const char = this.source[this.position];
      this.position += 1;
      if (char === "}") {
        return object;
      }
      if (char !== ",") {
        this.position -= 1;
        throw this.error("expected `,` or `}`");
      }
    }
  }
}

/** Parses one JSON document, keeping integers exact as `bigint`. */
export function parseJson(text: string): Json {
  return new Parser(text).parseDocument();
}

/**
 * Renders a decoded value compactly with sorted object keys, the way
 * `serde_json`'s `Display` does for the Rust runtime.
 */
export function jsonString(value: Json): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return value.toString();
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly Json[]).map(jsonString).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${sortedKeys(object).map(key => `${JSON.stringify(key)}:${jsonString(object[key]!)}`).join(",")}}`;
}

/** Reads `object[key]`, yielding `undefined` when `value` is not an object (like serde_json's `Index`). */
export function field(value: Json | undefined, key: string): Json | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as JsonObject)[key];
}

/** The `kind` discriminator of a normalized expression. */
export function kindOf(value: Json | undefined): string | undefined {
  const kind = field(value, "kind");
  return typeof kind === "string" ? kind : undefined;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Converts anything JSON-like (numbers, bigints, nested arrays and plain
 * objects) into the decoded form the artifact uses, so equality does not
 * depend on how the caller built the value.
 */
export function normalizeJson(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail(`fixture JSON is not encodable: ${value}`);
    }
    return Number.isInteger(value) ? BigInt(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (typeof value === "object") {
    const object: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) {
        object[key] = normalizeJson(nested);
      }
    }
    return object;
  }
  return fail(`fixture JSON is not encodable: ${String(value)}`);
}
