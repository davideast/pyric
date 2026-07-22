import { describe, expect, test } from 'bun:test';
import {
  plannedRequestCount,
  selectedProbes,
} from '../../src/run-storage-stdlib-discovery.ts';

describe('Storage stdlib discovery rig selection', () => {
  test('deduplicates selections and preserves the bounded request plan', () => {
    const selected = selectedProbes(['--probe', 'p0', '--probe=p0', '--probe=p2']);
    expect(selected).toEqual(['p0', 'p2']);
    expect(plannedRequestCount(selected)).toBe(13);
    expect(() => selectedProbes(['--probe=unknown'])).toThrow('Unknown probe');
  });
});
