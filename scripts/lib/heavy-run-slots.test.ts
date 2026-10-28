// The heavy-run slot limit's pure parts. The cases that start real holder
// processes and wait on real timers are in heavy-run-slots.slow.test.ts, which
// runs off the pull request path (`bun run test:slow`).
import { describe, expect, test } from 'bun:test';
import { formatDuration, waitingLine, type SlotHolder } from './heavy-run-slots.ts';

describe('the waiting line', () => {
  test('names each holder with its command, directory, pid and time held', () => {
    const base = { host: 'h', processStart: null, token: 't' };
    const holders: SlotHolder[] = [
      { ...base, pid: 11, cwd: '/w/a', command: 'bun run test', takenAt: 0 },
      { ...base, pid: 22, cwd: '/w/b', command: 'bun test/apps/run.ts demo', takenAt: 245_000 },
    ];
    expect(waitingLine(holders, 2, 250_000)).toBe(
      'waiting for a heavy-run slot (2 of 2 in use): bun run test in /w/a, pid 11, 4m 10s; bun test/apps/run.ts demo in /w/b, pid 22, 5s',
    );
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });
});
