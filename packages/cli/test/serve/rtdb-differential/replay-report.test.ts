import { describe, expect, test } from 'bun:test';
import {
  formatRtdbFailureReport,
  replayCommandForRtdbSeed,
  type Verdict,
} from './differential.js';

describe('RTDB differential failure replay command', () => {
  test('formats a copy-pastable replay command with --start, --count=1, and optional --steps', () => {
    expect(replayCommandForRtdbSeed(641042, 40)).toBe(
      'bun packages/cli/test/serve/rtdb-differential/differential.ts --start=641042 --count=1 --steps=40',
    );
    expect(replayCommandForRtdbSeed(17)).toBe(
      'bun packages/cli/test/serve/rtdb-differential/differential.ts --start=17 --count=1',
    );
  });

  test('includes the replay command, shrunk step summary, and mismatch location in failure output', () => {
    const original: Verdict = {
      sequence: {
        seed: 641042,
        instances: 2,
        initialRules: [0, 0],
        steps: [
          { op: 'set', db: 0, path: 'items/a', value: 1 },
          { op: 'get', db: 0, path: 'items/a' },
        ],
      },
      mismatch: {
        where: 'steps[1]',
        kind: 'step get',
        values: { sandbox: 1, worker: 2, node: 2 },
      },
      tolerated: [],
    };
    const shrunk: Verdict = {
      ...original,
      sequence: {
        ...original.sequence,
        steps: [{ op: 'get', db: 0, path: 'items/a' }],
      },
    };

    const report = formatRtdbFailureReport(original, shrunk, 40);
    expect(report).toContain('seed 641042: steps[1] (shrunk to 1 steps)');
    expect(report).toContain(
      'replay: bun packages/cli/test/serve/rtdb-differential/differential.ts --start=641042 --count=1 --steps=40',
    );
    expect(report).toContain('steps[1]: {"sandbox":1,"worker":2,"node":2}');
  });
});
