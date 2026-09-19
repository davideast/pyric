import { boundedActivityBytes, registerActivityValue } from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';

export class Bytes {
  private constructor(private readonly bytes: Uint8Array) {
    registerActivityValue(this, boundedActivityBytes(bytes));
    registerQueryValue(this, Object.freeze({
      type: 'bytes',
      values: Object.freeze(Array.from(bytes)),
    }), () => new Bytes(bytes.slice()));
  }

  static fromBase64String(base64: string): Bytes {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Bytes(bytes);
  }

  static fromUint8Array(array: Uint8Array): Bytes {
    return new Bytes(array.slice());
  }

  toBase64(): string {
    let binary = '';
    for (const byte of this.bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
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
    return { type: 'firestore/bytes/1.0', bytes: this.toBase64() };
  }

  static fromJSON(json: object): Bytes {
    const value = json as { readonly type?: unknown; readonly bytes?: unknown };
    const hasUnexpectedMarker = value.type !== 'firestore/bytes/1.0';
    const isInvalidBytesJson = hasUnexpectedMarker || typeof value.bytes !== 'string';
    if (isInvalidBytesJson) {
      throw new TypeError('Invalid Bytes JSON value.');
    }
    return Bytes.fromBase64String(value.bytes);
  }
}
