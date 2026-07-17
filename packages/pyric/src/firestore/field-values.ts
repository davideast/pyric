/**
 * `pyric/firestore` — field-value sentinels + sandbox scalar types.
 *
 * Canonical `firebase/firestore` imports still receive Firebase's classes
 * when package resolution has not selected Pyric. This mirror owns local
 * equivalents so its sandbox implementation never loads the production SDK.
 */
import {
  FieldValue as ChainFieldValue,
  Timestamp as ChainTimestamp,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-firestore';
import {
  boundedActivityBytes,
  boundedActivityIdentity,
  registerActivityValue,
} from 'pyric/firestore-values/internal';

export class Bytes {
  private constructor(private readonly bytes: Uint8Array) {
    registerActivityValue(this, boundedActivityBytes(bytes));
  }

  static fromBase64String(base64: string): Bytes {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
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
    const value = json as { type?: unknown; bytes?: unknown };
    if (value.type !== 'firestore/bytes/1.0' || typeof value.bytes !== 'string') {
      throw new TypeError('Invalid Bytes JSON value.');
    }
    return Bytes.fromBase64String(value.bytes);
  }
}

export class GeoPoint {
  constructor(
    private readonly lat: number,
    private readonly lng: number,
  ) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new TypeError('Latitude must be a number between -90 and 90.');
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new TypeError('Longitude must be a number between -180 and 180.');
    }
    registerActivityValue(
      this,
      boundedActivityIdentity('geo-point', String(lat), '\0', String(lng)),
    );
  }

  get latitude(): number { return this.lat; }
  get longitude(): number { return this.lng; }

  isEqual(other: GeoPoint): boolean {
    return other instanceof GeoPoint
      && this.lat === other.lat
      && this.lng === other.lng;
  }

  toJSON(): { latitude: number; longitude: number; type: string } {
    return {
      latitude: this.lat,
      longitude: this.lng,
      type: 'firestore/geoPoint/1.0',
    };
  }

  static fromJSON(json: object): GeoPoint {
    const value = json as { type?: unknown; latitude?: unknown; longitude?: unknown };
    if (
      value.type !== 'firestore/geoPoint/1.0'
      || typeof value.latitude !== 'number'
      || typeof value.longitude !== 'number'
    ) {
      throw new TypeError('Invalid GeoPoint JSON value.');
    }
    return new GeoPoint(value.latitude, value.longitude);
  }
}

export class FieldPath {
  readonly _internalPath: { segments: string[]; offset: number; len: number };

  constructor(...fieldNames: string[]) {
    if (fieldNames.length === 0 || fieldNames.some((name) => name.length === 0)) {
      throw new TypeError('FieldPath requires at least one non-empty field name.');
    }
    this._internalPath = {
      segments: fieldNames.slice(),
      offset: 0,
      len: fieldNames.length,
    };
  }

  isEqual(other: FieldPath): boolean {
    const ours = this._internalPath.segments;
    const theirs = other?._internalPath?.segments;
    return Array.isArray(theirs)
      && ours.length === theirs.length
      && ours.every((segment, index) => segment === theirs[index]);
  }
}

export function documentId(): FieldPath {
  return new FieldPath('__name__');
}

export class VectorValue {
  private constructor(readonly _values: number[]) {}

  static create(values: number[]): VectorValue {
    if (!values.every((value) => typeof value === 'number')) {
      throw new TypeError('Vector values must be numbers.');
    }
    return new VectorValue(values.slice());
  }

  toArray(): number[] {
    return this._values.slice();
  }

  isEqual(other: VectorValue): boolean {
    const theirs = other instanceof VectorValue ? other._values : undefined;
    return theirs !== undefined
      && this._values.length === theirs.length
      && this._values.every((value, index) => value === theirs[index]);
  }

  toJSON(): object {
    return {
      type: 'firestore/vectorValue/1.0',
      vectorValues: this.toArray(),
    };
  }

  static fromJSON(json: object): VectorValue {
    const value = json as { type?: unknown; vectorValues?: unknown };
    if (
      value.type !== 'firestore/vectorValue/1.0'
      || !Array.isArray(value.vectorValues)
      || !value.vectorValues.every((entry) => typeof entry === 'number')
    ) {
      throw new TypeError('Invalid VectorValue JSON value.');
    }
    return VectorValue.create(value.vectorValues);
  }
}

export function vector(values: number[] = []): VectorValue {
  return VectorValue.create(values);
}

export { ChainFieldValue as FieldValue, ChainTimestamp as Timestamp };

export function serverTimestamp(): FieldValueSentinel {
  return ChainFieldValue.serverTimestamp();
}
export function increment(n: number): FieldValueSentinel {
  return ChainFieldValue.increment(n);
}
export function arrayUnion(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayUnion(...values);
}
export function arrayRemove(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayRemove(...values);
}
export function deleteField(): FieldValueSentinel {
  return ChainFieldValue.delete();
}
