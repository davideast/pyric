import { describe, test, expect } from 'bun:test';
import { Timestamp } from '../../../src/rules/simulator/wrappers/timestamp.js';

describe('03-timestamp-iso-string-nanos-precision', () => {
  test('Timestamp.fromIsoString preserves 9-digit nanosecond precision', () => {
    const ts = Timestamp.fromIsoString('2026-09-25T12:00:00.123456789Z');
    expect(ts.nanos).toBe(123456789);
  });

  test('Timestamp.fromIsoString preserves 6-digit microsecond precision', () => {
    const ts = Timestamp.fromIsoString('2026-09-25T12:00:00.123456Z');
    expect(ts.nanos).toBe(123456000);
  });
});
