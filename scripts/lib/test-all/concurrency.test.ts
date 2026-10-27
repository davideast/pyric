import { describe, expect, test } from 'bun:test';
import { busyThreads, parseMemAvailable, parseProcStat } from '../machine-load.ts';
import { chooseConcurrency } from './concurrency.ts';

const GIB = 1024 ** 3;

describe('how many jobs test-all runs at once', () => {
  test('a machine runs half the threads its CPUs leave free', () => {
    expect(chooseConcurrency({ threads: 32, load: 8, freeMemoryBytes: 32 * GIB })).toBe(12);
    expect(chooseConcurrency({ threads: 8, load: 0.5, freeMemoryBytes: 32 * GIB })).toBe(3);
  });

  test('the count shrinks smoothly as the machine fills, down to one job', () => {
    const counts = [0, 8, 16, 22.4, 24, 28, 31, 32].map((load) => chooseConcurrency({ threads: 32, load, freeMemoryBytes: 32 * GIB }));
    expect(counts).toEqual([16, 12, 8, 4, 4, 2, 1, 1]);
  });

  test('no more jobs than free memory holds, at a gigabyte each', () => {
    expect(chooseConcurrency({ threads: 32, load: 0, freeMemoryBytes: 5.5 * GIB })).toBe(5);
    expect(chooseConcurrency({ threads: 32, load: 0, freeMemoryBytes: 0.5 * GIB })).toBe(1);
  });

  test('busy threads are the share of each CPU\'s time spent working between two readings', () => {
    const times = (busy: number, idle: number) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
    // CPU 0 worked 300 of 400 ms, CPU 1 worked none of 400 ms, CPU 2 worked all of 400 ms.
    const before = [times(1000, 1000), times(1000, 1000), times(1000, 1000)];
    const after = [times(1300, 1100), times(1000, 1400), times(1400, 1000)];
    expect(busyThreads(before, after)).toBeCloseTo(1.75);
  });

  test('free memory is MemAvailable, which counts reclaimable cache, not MemFree', () => {
    const meminfo = 'MemTotal:       32000000 kB\nMemFree:         9120128 kB\nMemAvailable:   25331352 kB\n';
    expect(parseMemAvailable(meminfo)).toBe(25331352 * 1024);
    expect(parseMemAvailable('MemTotal: 1 kB\n')).toBeUndefined();
  });

  test('/proc/stat counts iowait as idle, and irq, softirq and steal as work', () => {
    const stat = 'cpu  10 0 5 100 2 1 1 0 0 0\ncpu0 10 0 5 100 2 1 1 0 0 0\nintr 123\n';
    expect(parseProcStat(stat)).toEqual([{ times: { user: 10, nice: 0, sys: 5, idle: 102, irq: 2 } }]);
  });
});
