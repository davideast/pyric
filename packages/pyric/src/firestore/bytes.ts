import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { validateFirestoreJson, type JsonObjectSchema } from './json-schema.js';
import { boundedActivityBytes, registerActivityValue } from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';

const BYTES_JSON_TYPE = 'firestore/bytes/1.0';
const BYTES_JSON_SCHEMA: JsonObjectSchema = {
  type: { typeString: 'string', expectedValue: BYTES_JSON_TYPE },
  bytes: { typeString: 'string' },
};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64Pure(raw: string): Uint8Array {
  const cleaned = raw.replace(/[\t\n\f\r ]+/g, '');
  if (cleaned.length === 0) return new Uint8Array(0);
  let padded = cleaned;
  if (padded.length % 4 !== 0) {
    if (padded.endsWith('=')) {
      throw new Error('Invalid base64 padding.');
    }
    const remainder = padded.length % 4;
    if (remainder === 1) {
      throw new Error('Invalid base64 length.');
    }
    padded = padded.padEnd(padded.length + (4 - remainder), '=');
  }
  let padCount = 0;
  if (padded.endsWith('==')) padCount = 2;
  else if (padded.endsWith('=')) padCount = 1;
  const bodyLimit = padded.length - padCount;
  for (let i = 0; i < bodyLimit; i += 1) {
    if (BASE64_ALPHABET.indexOf(padded[i] ?? '') < 0) {
      throw new Error('Invalid character in base64 input.');
    }
  }
  const outLength = (padded.length / 4) * 3 - padCount;
  const out = new Uint8Array(outLength);
  let outIndex = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(padded[i] ?? '');
    const c1 = BASE64_ALPHABET.indexOf(padded[i + 1] ?? '');
    const ch2 = padded[i + 2] ?? '=';
    const ch3 = padded[i + 3] ?? '=';
    const c2 = ch2 === '=' ? 0 : BASE64_ALPHABET.indexOf(ch2);
    const c3 = ch3 === '=' ? 0 : BASE64_ALPHABET.indexOf(ch3);
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIndex < outLength) {
      out[outIndex] = (triple >> 16) & 0xff;
      outIndex += 1;
    }
    if (outIndex < outLength) {
      out[outIndex] = (triple >> 8) & 0xff;
      outIndex += 1;
    }
    if (outIndex < outLength) {
      out[outIndex] = triple & 0xff;
      outIndex += 1;
    }
  }
  return out;
}

function encodeBase64Pure(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? (bytes[i + 1] ?? 0) : 0;
    const b2 = hasB2 ? (bytes[i + 2] ?? 0) : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    out += hasB1 ? BASE64_ALPHABET[(triple >> 6) & 0x3f] : '=';
    out += hasB2 ? BASE64_ALPHABET[triple & 0x3f] : '=';
  }
  return out;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof base64 !== 'string') {
    throw new FirebaseError(
      'invalid-argument',
      `Failed to construct data from Base64 string: Invalid base64 string: ${String(base64)}`,
    );
  }
  try {
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(base64);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    return decodeBase64Pure(base64);
  } catch (error) {
    let detail = String(error);
    if (error instanceof Error) {
      detail = `${error.name}: ${error.message}`;
    }
    throw new FirebaseError(
      'invalid-argument',
      `Failed to construct data from Base64 string: Invalid base64 string: ${detail}`,
    );
  }
}

export class Bytes {
  private constructor(private readonly bytes: Uint8Array) {
    registerActivityValue(this, boundedActivityBytes(bytes));
    registerQueryValue(this, Object.freeze({
      type: 'bytes',
      values: Object.freeze(Array.from(bytes)),
    }), () => new Bytes(bytes.slice()));
  }

  static fromBase64String(base64: string): Bytes {
    return new Bytes(decodeBase64ToBytes(base64));
  }

  static fromUint8Array(array: Uint8Array): Bytes {
    return new Bytes(array.slice());
  }

  toBase64(): string {
    if (typeof globalThis.btoa === 'function') {
      let binary = '';
      for (const byte of this.bytes) binary += String.fromCharCode(byte);
      return globalThis.btoa(binary);
    }
    return encodeBase64Pure(this.bytes);
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice();
  }

  toString(): string {
    return `Bytes(base64: ${this.toBase64()})`;
  }

  isEqual(other: Bytes): boolean {
    return other instanceof Bytes
      && this.bytes.length === other.bytes.length
      && this.bytes.every((byte, index) => byte === other.bytes[index]);
  }

  toJSON(): object {
    return { type: BYTES_JSON_TYPE, bytes: this.toBase64() };
  }

  static fromJSON(json: object): Bytes {
    const validated = validateFirestoreJson(json, BYTES_JSON_SCHEMA);
    return Bytes.fromBase64String(validated.bytes as string);
  }
}
