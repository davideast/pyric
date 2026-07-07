/**
 * Bytes wrapper — Item 5.3 of REBUILD_PLAN.md.
 *
 * Per type table:
 *   size() → Integer       byte count
 *   toBase64() → String    Base64url per RFC 4648 (URL-safe, no padding)
 *   toHexString() → String lowercase hex
 *
 * Per 0.B per-wrapper table:
 *   typeName: 'bytes'
 *   valueOf:  data.length (byte count)
 *   toString: base64url encoding (round-trips with hashing.* receipts)
 *   equals:   byte-by-byte
 *   binaryOp: lexicographic compare for < <= > >=
 *
 * Bytes was deferred from Item 1 because it has no JSON-test-data
 * sentinel form — it only enters the evaluator via String.toUtf8() and
 * hashing.*, both of which land in this same item (5.3). Landing the
 * wrapper now means the constructors immediately have a real type to
 * return.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';

// Base64url + hex encoders. Browser-safe — no Buffer, no node:crypto.
// Behavior pinned by bytes.test.ts to match the previous Buffer-based
// output across UTF-8 / arbitrary-byte / empty fixtures.
const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >>> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  // btoa exists in browsers and Node 16+; we encode the byte string
  // through it, then map the standard alphabet to URL-safe (- _) and
  // strip padding per RFC 4648 section 5.
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const std = btoa(bin);
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function lexicographicCompare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

export class Bytes extends RulesValue {
  readonly typeName = 'bytes';

  /** Raw byte data. Held as Uint8Array for predictable ordering and length. */
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    super();
    this.data = data;
  }

  /** Construct from a UTF-8 string. */
  static fromUtf8(s: string): Bytes {
    return new Bytes(new TextEncoder().encode(s));
  }

  /** Construct from a hex string (e.g. 'deadbeef'). */
  static fromHex(hex: string): Bytes {
    if (hex.length % 2 !== 0) {
      throw new Error(`Invalid hex string length: ${hex.length}`);
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return new Bytes(out);
  }

  /** Byte count — exposed via callMethod('size'). Also drives valueOf(). */
  size(): number {
    return this.data.length;
  }

  /** Base64url per RFC 4648 (URL-safe, no padding). */
  toBase64(): string {
    return toBase64Url(this.data);
  }

  /** Lowercase hex. */
  toHexString(): string {
    return toHex(this.data);
  }

  // ─── RulesValue contract ─────────────────────────────────────────────

  valueOf(): number {
    return this.data.length;
  }

  toString(): string {
    return this.toBase64();
  }

  toJSON(): unknown {
    return { __type: 'bytes', base64: this.toBase64() };
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Bytes)) return false;
    if (this.data.length !== other.data.length) return false;
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] !== other.data[i]) return false;
    }
    return true;
  }

  callMethod(method: string, _args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'size': return this.size();
      case 'toBase64': return this.toBase64();
      case 'toHexString': return this.toHexString();
    }
    return NO_OP;
  }

  binaryOp(op: string, other: unknown): unknown | NoOp {
    if (!(other instanceof Bytes)) return NO_OP;
    const cmp = lexicographicCompare(this.data, other.data);
    switch (op) {
      case '<': return cmp < 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '>=': return cmp >= 0;
    }
    return NO_OP;
  }
}
