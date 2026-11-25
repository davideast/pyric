/**
 * Public TypeScript contracts for Firestore Enterprise BSON value classes in
 * `pyric/firestore`.
 *
 * Exported only in the TypeScript type namespace so the deferred runtime
 * disposition in `packages/conformance/surfaces/firestore.json` remains
 * accurate while consumer type annotations continue type-checking.
 */

export interface BsonObjectId {
  readonly value: string;
  isEqual(other: BsonObjectId): boolean;
}

export interface BsonTimestamp {
  readonly seconds: number;
  readonly increment: number;
  isEqual(other: BsonTimestamp): boolean;
}

export interface Decimal128Value {
  readonly stringValue: string;
  isEqual(other: Decimal128Value): boolean;
  toJSON(): object;
}

export interface Int32Value {
  readonly value: number;
  isEqual(other: Int32Value): boolean;
}

export interface MaxKey {
  readonly type: 'MaxKey';
}

export interface MinKey {
  readonly type: 'MinKey';
}

export interface RegexValue {
  readonly pattern: string;
  readonly options: string;
  isEqual(other: RegexValue): boolean;
}
