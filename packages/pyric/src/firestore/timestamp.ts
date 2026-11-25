import {
  boundedActivityIdentity,
  registerActivityValue,
} from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { validateFirestoreJson, type JsonObjectSchema } from './json-schema.js';

const MIN_SECONDS = -62_135_596_800;
const MAX_SECONDS_EXCLUSIVE = 253_402_300_800;
const TIMESTAMP_JSON_TYPE = 'firestore/timestamp/1.0';
const TIMESTAMP_JSON_SCHEMA: JsonObjectSchema = {
  type: { typeString: 'string', expectedValue: TIMESTAMP_JSON_TYPE },
  seconds: { typeString: 'number' },
  nanoseconds: { typeString: 'number' },
};

export function isValidTimestampComponents(
  seconds: unknown,
  nanoseconds: unknown,
): boolean {
  return (
    Number.isInteger(seconds)
    && (seconds as number) >= MIN_SECONDS
    && (seconds as number) < MAX_SECONDS_EXCLUSIVE
    && Number.isInteger(nanoseconds)
    && (nanoseconds as number) >= 0
    && (nanoseconds as number) < 1_000_000_000
  );
}

export function assertValidTimestampComponents(
  seconds: unknown,
  nanoseconds: unknown,
): void {
  if (
    !Number.isInteger(nanoseconds)
    || (nanoseconds as number) < 0
    || (nanoseconds as number) >= 1_000_000_000
  ) {
    throw new FirebaseError(
      'invalid-argument',
      `Timestamp nanoseconds out of range: ${String(nanoseconds)}`,
    );
  }
  if (
    !Number.isInteger(seconds)
    || (seconds as number) < MIN_SECONDS
    || (seconds as number) >= MAX_SECONDS_EXCLUSIVE
  ) {
    throw new FirebaseError(
      'invalid-argument',
      `Timestamp seconds out of range: ${String(seconds)}`,
    );
  }
}

export class Timestamp {
  constructor(
    public readonly seconds: number,
    public readonly nanoseconds: number,
  ) {
    assertValidTimestampComponents(seconds, nanoseconds);
    registerActivityValue(
      this,
      boundedActivityIdentity('timestamp', String(seconds), '\0', String(nanoseconds)),
    );
    registerQueryValue(this, Object.freeze({
      type: 'timestamp',
      seconds,
      nanoseconds,
    }), () => new Timestamp(seconds, nanoseconds));
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number): Timestamp {
    // FS-B12 -- derive nanoseconds as `floor((ms - seconds*1000) * 1e6)` so
    // the value is ALWAYS non-negative (matching `fb.Timestamp.fromMillis`).
    // The old `(ms % 1000) * 1e6` produced negative nanos for negative
    // millis, so `fromMillis(-500)` round-tripped to -1500 via toMillis().
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.floor((ms - seconds * 1000) * 1_000_000);
    return new Timestamp(seconds, nanoseconds);
  }
  static fromJSON(json: object): Timestamp {
    const validated = validateFirestoreJson(json, TIMESTAMP_JSON_SCHEMA);
    return new Timestamp(
      validated.seconds as number,
      validated.nanoseconds as number,
    );
  }
  static fromInstant(instant: { readonly epochNanoseconds: bigint }): Timestamp {
    if (
      instant === null ||
      instant === undefined ||
      typeof instant.epochNanoseconds !== 'bigint'
    ) {
      throw new Error('Invalid Temporal.Instant object provided.');
    }
    const nanos = instant.epochNanoseconds;
    const billion = 1_000_000_000n;
    if (nanos >= 0n) {
      return new Timestamp(Number(nanos / billion), Number(nanos % billion));
    }
    const rem = nanos % billion;
    if (rem === 0n) {
      return new Timestamp(Number(nanos / billion), 0);
    }
    return new Timestamp(Number(nanos / billion - 1n), Number(rem + billion));
  }
  toInstant(): {
    readonly [Symbol.toStringTag]?: string;
    readonly epochMilliseconds: number;
    readonly epochNanoseconds: bigint;
    toString(): string;
  } {
    const temporal = (
      globalThis as {
        readonly Temporal?: {
          readonly Instant?: {
            fromEpochNanoseconds(epochNanoseconds: bigint): {
              readonly [Symbol.toStringTag]?: string;
              readonly epochMilliseconds: number;
              readonly epochNanoseconds: bigint;
              toString(): string;
            };
          };
        };
      }
    ).Temporal;
    if (temporal === undefined || temporal.Instant === undefined) {
      throw new Error('The Temporal object is not available in the current environment.');
    }
    const nanos = BigInt(this.seconds) * 1_000_000_000n + BigInt(this.nanoseconds);
    return temporal.Instant.fromEpochNanoseconds(nanos);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  toMillis(): number {
    // FS-B12 -- `nanoseconds / 1e6` (matching `fb.Timestamp.toMillis`), not
    // `floor(nanoseconds / 1e6)`; the floor dropped sub-millisecond nanos
    // and broke the negative-millis round-trip.
    return this.seconds * 1000 + this.nanoseconds / 1_000_000;
  }
  /** FS-B12 -- value equality, mirroring `fb.Timestamp.isEqual`. */
  isEqual(other: Timestamp): boolean {
    return other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  /** FS-B12 -- textual form, mirroring `fb.Timestamp.toString`. */
  toString(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
  /** FS-B12 -- JSON form, mirroring `fb.Timestamp.toJSON`. */
  toJSON(): { type: string; seconds: number; nanoseconds: number } {
    return {
      type: TIMESTAMP_JSON_TYPE,
      seconds: this.seconds,
      nanoseconds: this.nanoseconds,
    };
  }
  /**
   * FS-B12 -- primitive coercion for `<`/`<=`/`>=`/`>` comparisons, mirroring
   * `fb.Timestamp.valueOf`: a zero-padded `<seconds>.<nanoseconds>` string
   * (seconds offset by MIN_SECONDS so it stays non-negative and lexically
   * ordered).
   */
  valueOf(): string {
    const adjustedSeconds = this.seconds - MIN_SECONDS;
    const formattedSeconds = String(adjustedSeconds).padStart(12, '0');
    const formattedNanoseconds = String(this.nanoseconds).padStart(9, '0');
    return `${formattedSeconds}.${formattedNanoseconds}`;
  }
}
