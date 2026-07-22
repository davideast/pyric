import { describe, expect, test } from 'bun:test';
import { acquireRunLock } from '../../src/run-storage-stdlib-real.ts';

describe('storage stdlib real runner', () => {
  test('exclusive lock rejects an overlapping real-resource run', () => {
    const path = `/tmp/pyric-storage-stdlib-real-test-${process.pid}.lock`;
    const release = acquireRunLock(path);
    try {
      expect(() => acquireRunLock(path))
        .toThrow('another storage-stdlib real-resource probe is already running');
    } finally {
      release();
    }
  });
});
