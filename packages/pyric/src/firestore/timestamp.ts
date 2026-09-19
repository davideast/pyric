import {
  boundedActivityIdentity,
  registerActivityValue,
} from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';

const MIN_SECONDS = -62_135_596_800;
const MAX_SECONDS_EXCLUSIVE = 253_402_300_800;

export class Timestamp {
  constructor(
    public readonly seconds: number,
    public readonly nanoseconds: number,
  ) {
    const nanosecondsOutOfRange = nanoseconds < 0 || nanoseconds >= 1_000_000_000;
    if (nanosecondsOutOfRange) {
      throw new FirebaseError('invalid-argument', `Timestamp nanoseconds out of range: ${nanoseconds}`);
    }
    const secondsOutOfRange = seconds < MIN_SECONDS || seconds >= MAX_SECONDS_EXCLUSIVE;
    if (secondsOutOfRange) {
      throw new FirebaseError('invalid-argument', `Timestamp seconds out of range: ${seconds}`);
    }
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
    // FS-B12 — derive nanoseconds as `floor((ms - seconds*1000) * 1e6)` so
    // the value is ALWAYS non-negative (matching `fb.Timestamp.fromMillis`).
    // The old `(ms % 1000) * 1e6` produced negative nanos for negative
    // millis, so `fromMillis(-500)` round-tripped to -1500 via toMillis().
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.floor((ms - seconds * 1000) * 1_000_000);
    return new Timestamp(seconds, nanoseconds);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  toMillis(): number {
    // FS-B12 — `nanoseconds / 1e6` (matching `fb.Timestamp.toMillis`), not
    // `floor(nanoseconds / 1e6)`; the floor dropped sub-millisecond nanos
    // and broke the negative-millis round-trip.
    return this.seconds * 1000 + this.nanoseconds / 1_000_000;
  }
  /** FS-B12 — value equality, mirroring `fb.Timestamp.isEqual`. */
  isEqual(other: Timestamp): boolean {
    return other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  /** FS-B12 — textual form, mirroring `fb.Timestamp.toString`. */
  toString(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
  /** FS-B12 — JSON form, mirroring `fb.Timestamp.toJSON`. */
  toJSON(): { type: string; seconds: number; nanoseconds: number } {
    return {
      type: 'firestore/timestamp/1.0',
      seconds: this.seconds,
      nanoseconds: this.nanoseconds,
    };
  }
  /**
   * FS-B12 — primitive coercion for `<`/`<=`/`>=`/`>` comparisons, mirroring
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
