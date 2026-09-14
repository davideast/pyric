/**
 * Normalize SDK and decoded Timestamp values at the Firestore write boundary.
 * Firestore stores microsecond precision; rules must inspect that same value
 * before deciding whether a write is allowed. Preserve the caller's object.
 *
 * Decoded rules wrappers already at storage precision are left alone, making
 * repeated write preparation idempotent. The SDK shape is recognized without
 * a Firebase dependency, including instances from a separately installed SDK.
 */
import { KEEP, type ValueConverter } from '../value-resolver.js';
import { Timestamp as RulesTimestamp } from 'pyric/rules/internal';

/** Minimal duck-type for a compat / `firebase/firestore` `Timestamp`. */
interface UserTimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}

function isUserTimestamp(v: unknown): v is UserTimestampLike {
  if (v === null || typeof v !== 'object') return false;
  // Our own output (the internal wrapper) is already normalized.
  if (v instanceof RulesTimestamp) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seconds === 'number' &&
    typeof o.nanoseconds === 'number' &&
    typeof o.toMillis === 'function'
  );
}

export const userTimestampConverter: ValueConverter = {
  name: 'user-timestamp-to-rules-timestamp',
  convert(value) {
    const isRulesTimestamp = value instanceof RulesTimestamp;
    if (isRulesTimestamp) {
      const nanoseconds = Math.floor(value.nanos / 1_000) * 1_000;
      const hasMicrosecondPrecision = nanoseconds === value.nanos;
      if (hasMicrosecondPrecision) return KEEP;
      return new RulesTimestamp(value.seconds, nanoseconds);
    }
    const isSdkTimestamp = isUserTimestamp(value);
    if (isSdkTimestamp) {
      const nanoseconds = Math.floor(value.nanoseconds / 1_000) * 1_000;
      return new RulesTimestamp(value.seconds, nanoseconds);
    }
    return KEEP;
  },
};
