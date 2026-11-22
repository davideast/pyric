/**
 * Lossless int64 JSON parsing and serialization for Auth token claims (#1817).
 *
 * JavaScript's `JSON.parse` rounds every integer at or past 2^53 to an
 * IEEE-754 double before the rules engine ever sees it. The parser here
 * validates input with `JSON.parse` first, fast-paths payloads with no large
 * integers or exponents, and otherwise parses exact integers in
 * `[-(2^63), 2^63 - 1]` outside JS's safe-integer range as `bigint` while
 * keeping safe integers (`|n| <= 2^53 - 1`), fractions, and numbers past int64
 * as JavaScript `number`.
 *
 * Browser-, worker-, Node-, and Bun-safe: no `node:*` imports.
 */

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const MAY_CONTAIN_LARGE_INT = /\d{16}|\d[eE]/;
const NUMBER_PARTS = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_EXACT_INT64_DIGITS = 19;

function stripLeadingZeros(digits: string): string {
  let start = 0;
  while (start < digits.length && digits.charCodeAt(start) === 48) {
    start++;
  }
  return digits.slice(start);
}

function stripTrailingZeros(digits: string): { trimmed: string; removed: number } {
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) {
    end--;
  }
  return { trimmed: digits.slice(0, end), removed: digits.length - end };
}

function parseJsonNumberToken(raw: string): number | bigint {
  const asNumber = Number(raw);
  const match = NUMBER_PARTS.exec(raw);
  if (match === null) return asNumber;
  const sign = match[1] ?? '';
  const intPart = match[2] ?? '';
  const fracPart = match[3];
  const expPart = match[4];

  if (fracPart === undefined && expPart === undefined) {
    if (intPart.length <= 15) return asNumber;
    if (intPart.length > MAX_EXACT_INT64_DIGITS) return asNumber;
    const exact = BigInt(raw);
    if (exact >= MIN_SAFE_BIGINT && exact <= MAX_SAFE_BIGINT) return asNumber;
    if (exact >= INT64_MIN && exact <= INT64_MAX) return exact;
    return asNumber;
  }

  let expNum = 0;
  if (expPart !== undefined) {
    expNum = Number(expPart);
    if (!Number.isSafeInteger(expNum)) return asNumber;
  }

  const combined = fracPart === undefined ? intPart : `${intPart}${fracPart}`;
  const noLeading = stripLeadingZeros(combined);
  if (noLeading.length === 0) return asNumber;

  const { trimmed, removed } = stripTrailingZeros(noLeading);
  const fracLen = fracPart === undefined ? 0 : fracPart.length;
  const shift = expNum - fracLen + removed;
  if (shift < 0) return asNumber;
  if (trimmed.length + shift > MAX_EXACT_INT64_DIGITS) return asNumber;

  const exact = BigInt(`${sign}${trimmed}${'0'.repeat(shift)}`);
  if (exact >= MIN_SAFE_BIGINT && exact <= MAX_SAFE_BIGINT) return asNumber;
  if (exact >= INT64_MIN && exact <= INT64_MAX) return exact;
  return asNumber;
}

class ClaimJsonScanner {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseRoot(): unknown {
    this.skipWhitespace();
    return this.parseValue();
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text.charCodeAt(this.pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const ch = this.text.charCodeAt(this.pos);
    if (ch === 123) return this.parseObject();
    if (ch === 91) return this.parseArray();
    if (ch === 34) return this.parseString();
    if (ch === 116) {
      this.pos += 4;
      return true;
    }
    if (ch === 102) {
      this.pos += 5;
      return false;
    }
    if (ch === 110) {
      this.pos += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.text.length) {
      const ch = this.text.charCodeAt(this.pos);
      if (ch === 92) {
        this.pos += 2;
        continue;
      }
      if (ch === 34) {
        this.pos++;
        return JSON.parse(this.text.slice(start, this.pos)) as string;
      }
      this.pos++;
    }
    return JSON.parse(this.text.slice(start)) as string;
  }

  private parseNumber(): number | bigint {
    const start = this.pos;
    while (this.pos < this.text.length) {
      const ch = this.text.charCodeAt(this.pos);
      const isNumChar =
        (ch >= 48 && ch <= 57)
        || ch === 45
        || ch === 43
        || ch === 46
        || ch === 101
        || ch === 69;
      if (!isNumChar) break;
      this.pos++;
    }
    return parseJsonNumberToken(this.text.slice(start, this.pos));
  }

  private parseArray(): unknown[] {
    this.pos++;
    const items: unknown[] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.pos) === 93) {
      this.pos++;
      return items;
    }
    while (this.pos < this.text.length) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const ch = this.text.charCodeAt(this.pos);
      if (ch === 44) {
        this.pos++;
        continue;
      }
      if (ch === 93) {
        this.pos++;
        return items;
      }
      break;
    }
    return items;
  }

  private parseObject(): Record<string, unknown> {
    this.pos++;
    const record: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.text.charCodeAt(this.pos) === 125) {
      this.pos++;
      return record;
    }
    while (this.pos < this.text.length) {
      this.skipWhitespace();
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text.charCodeAt(this.pos) === 58) this.pos++;
      const value = this.parseValue();
      Object.defineProperty(record, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const ch = this.text.charCodeAt(this.pos);
      if (ch === 44) {
        this.pos++;
        continue;
      }
      if (ch === 125) {
        this.pos++;
        return record;
      }
      break;
    }
    return record;
  }
}

/**
 * Parse a JSON claim payload without losing precision on integral numbers in
 * signed 64-bit integer range (`[-(2^63), 2^63 - 1]`). Safe integers remain
 * JavaScript numbers; exact int64 integers with magnitude >= 2^53 decode to
 * `bigint`; fractions and numbers outside int64 decode to JavaScript numbers.
 */
export function parseClaimJson(text: string): unknown {
  const nativeParsed: unknown = JSON.parse(text);
  if (!MAY_CONTAIN_LARGE_INT.test(text)) return nativeParsed;
  return new ClaimJsonScanner(text).parseRoot();
}

function serializeClaimNode(value: unknown, ancestors: Set<object>): string | undefined {
  let current: unknown = value;
  if (current !== null && typeof current === 'object') {
    const maybeToJson = (current as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJson === 'function') {
      current = (maybeToJson as () => unknown).call(current);
    }
  }
  if (typeof current === 'bigint') return current.toString();
  if (current === null || typeof current === 'boolean' || typeof current === 'string') {
    return JSON.stringify(current);
  }
  if (typeof current === 'number') {
    if (!Number.isFinite(current)) return 'null';
    return JSON.stringify(current);
  }
  if (typeof current !== 'object') return undefined;
  if (ancestors.has(current)) {
    throw new TypeError('Converting circular structure to JSON');
  }
  ancestors.add(current);
  try {
    if (Array.isArray(current)) {
      const items: string[] = [];
      for (const entry of current) {
        const encoded = serializeClaimNode(entry, ancestors);
        items.push(encoded === undefined ? 'null' : encoded);
      }
      return `[${items.join(',')}]`;
    }
    const entries: string[] = [];
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      const encoded = serializeClaimNode(entry, ancestors);
      if (encoded === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(current);
  }
}

/**
 * Serialize a claim payload to JSON, emitting `bigint` values as raw JSON
 * integer literals so 64-bit integral claims survive JWT encoding and cache
 * key hashing without rounding or throwing.
 */
export function stringifyClaimJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return serializeClaimNode(value, new Set()) as string;
  }
}
