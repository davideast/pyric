/**
 * FS-B12 — compat `Timestamp` nanos normalization + value API.
 *
 * Pre-fix the admin-compat `Timestamp` computed `nanoseconds` as
 * `(ms % 1000) * 1e6`, which is NEGATIVE for negative millis, so
 * `fromMillis(-500).toMillis()` returned -1500 instead of -500. It also
 * lacked `isEqual` / `toString` / `toJSON` / `valueOf`, which the
 * `fb.Timestamp` surface ships. These probes mirror
 * `clones/.../lite-api/timestamp.ts`.
 */
import { describe, test, expect } from 'bun:test';
import { Timestamp } from '../../../../src/firestore/sandbox/admin-compat/types.js';

describe('FS-B12 — nanos normalization', () => {
  test('fromMillis(-500) round-trips through toMillis()', () => {
    expect(Timestamp.fromMillis(-500).toMillis()).toBe(-500);
  });

  test('nanoseconds are always non-negative', () => {
    const ts = Timestamp.fromMillis(-500);
    expect(ts.nanoseconds).toBeGreaterThanOrEqual(0);
    expect(ts.nanoseconds).toBeLessThan(1_000_000_000);
    // (-1, 500_000_000) is the canonical decomposition of -500ms.
    expect(ts.seconds).toBe(-1);
    expect(ts.nanoseconds).toBe(500_000_000);
  });

  test('positive sub-second millis preserved (no floor loss)', () => {
    expect(Timestamp.fromMillis(1_500).toMillis()).toBe(1_500);
    expect(Timestamp.fromMillis(123).toMillis()).toBe(123);
  });
});

describe('FS-B12 — value API', () => {
  test('isEqual compares by value', () => {
    expect(new Timestamp(100, 5).isEqual(new Timestamp(100, 5))).toBe(true);
    expect(new Timestamp(100, 5).isEqual(new Timestamp(100, 6))).toBe(false);
  });

  test('toString matches fb.Timestamp format', () => {
    expect(new Timestamp(100, 5).toString()).toBe('Timestamp(seconds=100, nanoseconds=5)');
  });

  test('toJSON carries the typed schema marker', () => {
    expect(new Timestamp(100, 5).toJSON()).toEqual({
      type: 'firestore/timestamp/1.0',
      seconds: 100,
      nanoseconds: 5,
    });
  });

  test('valueOf yields a lexically-orderable padded string', () => {
    const a = new Timestamp(100, 5);
    const b = new Timestamp(100, 6);
    const c = new Timestamp(101, 0);
    // String comparison via valueOf orders timestamps correctly.
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    // The format is <12-digit seconds>.<9-digit nanos>.
    expect(a.valueOf()).toMatch(/^\d{12}\.\d{9}$/);
  });
});
