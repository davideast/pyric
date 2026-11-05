import { describe, expect, test } from 'bun:test';
import {
  ActionLog,
  DEFAULT_MINUTES,
  DEFAULT_SEED,
  judgeGrowth,
  parseSeed,
  pickAction,
  seededRandom,
  soakSettings,
  type GrowthLimit,
  type MemorySample,
} from './soak.ts';

const MB = 1024 * 1024;
const LIMIT: GrowthLimit = { floorBytes: 32 * MB, ratio: 0.5, minSamples: 6 };

function draws(seed: number, count: number): number[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => random.next());
}

function epoch(epochNumber: number, levels: number[]): MemorySample[] {
  return levels.map((level, index) => ({ at: index * 30, epoch: epochNumber, bytes: level * MB }));
}

describe('seededRandom', () => {
  test('one seed draws the same numbers every time', () => {
    expect(draws(42, 50)).toEqual(draws(42, 50));
  });

  test('another seed draws other numbers', () => {
    expect(draws(42, 10)).not.toEqual(draws(43, 10));
  });

  test('draws stay in [0, 1) and spread over it', () => {
    const values = draws(7, 10_000);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.02);
  });

  test('int covers both ends of its range and nothing past them', () => {
    const random = seededRandom(9);
    const seen = new Set(Array.from({ length: 2_000 }, () => random.int(3, 6)));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  test('pick refuses an empty list', () => {
    expect(() => seededRandom(1).pick([])).toThrow('at least one item');
  });
});

describe('pickAction', () => {
  const choices = [
    { name: 'write', weight: 6 },
    { name: 'read', weight: 3 },
    { name: 'reload', weight: 1 },
    { name: 'never', weight: 0 },
  ] as const;

  test('one seed picks the same sequence', () => {
    const run = (seed: number) => {
      const random = seededRandom(seed);
      return Array.from({ length: 200 }, () => pickAction(random, choices));
    };
    expect(run(11)).toEqual(run(11));
  });

  test('picks in proportion to weight and never picks a weight of 0', () => {
    const random = seededRandom(5);
    const counts = { write: 0, read: 0, reload: 0, never: 0 };
    for (let i = 0; i < 10_000; i += 1) counts[pickAction(random, choices)] += 1;
    expect(counts.never).toBe(0);
    expect(counts.write / 10_000).toBeCloseTo(0.6, 1);
    expect(counts.read / 10_000).toBeCloseTo(0.3, 1);
    expect(counts.reload / 10_000).toBeCloseTo(0.1, 1);
  });

  test('takes one draw per pick, so a replay stays in step', () => {
    const random = seededRandom(3);
    pickAction(random, choices);
    const after = random.next();
    const reference = seededRandom(3);
    reference.next();
    expect(after).toBe(reference.next());
  });

  test('fails when every weight is 0', () => {
    expect(() => pickAction(seededRandom(1), [{ name: 'a', weight: 0 }])).toThrow('no action has a weight above 0: a');
  });
});

describe('soakSettings', () => {
  test('defaults to the fixed seed and an hour, checked every three minutes', () => {
    const settings = soakSettings({});
    expect(settings).toEqual({ seed: DEFAULT_SEED, minutes: DEFAULT_MINUTES, checkpointMs: 180_000, sampleMs: 30_000 });
  });

  test('a short run checks six times', () => {
    expect(soakSettings({ SOAK_MINUTES: '2' })).toMatchObject({ minutes: 2, checkpointMs: 20_000, sampleMs: 5_000 });
  });

  test('takes a number seed as itself and hashes a word', () => {
    expect(soakSettings({ SOAK_SEED: '123' }).seed).toBe(123);
    expect(parseSeed('nightly')).toBe(parseSeed('nightly'));
    expect(parseSeed('nightly')).not.toBe(parseSeed('nightlz'));
  });

  test('refuses minutes that are not a positive number', () => {
    expect(() => soakSettings({ SOAK_MINUTES: 'soon' })).toThrow('SOAK_MINUTES must be a positive number');
    expect(() => soakSettings({ SOAK_MINUTES: '0' })).toThrow('SOAK_MINUTES must be a positive number');
  });
});

describe('ActionLog', () => {
  test('the failure report names the seed, the action, the replay, and only the last 20 actions', () => {
    const log = new ActionLog();
    for (let i = 0; i < 30; i += 1) log.add('set post', `p-${i}`);
    log.note(29, 'uid u1');
    const report = log.describeFailure(77, 29, 'the read did not match');
    expect(report).toStartWith('the soak failed at action 29 (SOAK_SEED=77): the read did not match');
    expect(report).toContain('replay: SOAK_SEED=77 ');
    expect(report).toContain('the last 20 actions:');
    expect(report).toContain('#29 ');
    expect(report).toContain('set post p-29; uid u1');
    expect(report).toContain('#10 ');
    expect(report).not.toContain('#9 ');
  });
});

describe('judgeGrowth', () => {
  test('a heap that climbs and settles is not growth', () => {
    const verdict = judgeGrowth(epoch(0, [20, 60, 62, 61, 63, 60, 62, 61, 63, 62]), LIMIT);
    expect(verdict.growing).toBe(false);
  });

  test('a sawtooth that collects back down is not growth', () => {
    const verdict = judgeGrowth(epoch(0, [50, 60, 120, 60, 130, 60, 125, 60, 130, 60]), LIMIT);
    expect(verdict.growing).toBe(false);
  });

  test('a steady climb past both bounds is growth, and the line says so', () => {
    const verdict = judgeGrowth(epoch(0, [40, 50, 60, 70, 80, 90, 100, 110, 120, 130]), LIMIT);
    expect(verdict.growing).toBe(true);
    expect(verdict.lines[0]).toMatch(/^epoch 0: 9 samples, .* steady growth$/);
  });

  test('a steady climb under the byte floor is not growth', () => {
    const verdict = judgeGrowth(epoch(0, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), LIMIT);
    expect(verdict.growing).toBe(false);
  });

  test('each epoch is judged on its own, so a restart that frees memory hides nothing', () => {
    const settled = epoch(0, [100, 100, 101, 100, 101, 100, 101]);
    const climbing = epoch(1, [40, 50, 60, 70, 80, 90, 100, 110, 120, 130]);
    expect(judgeGrowth([...settled, ...climbing], LIMIT).growing).toBe(true);
    // Read as one series, the drop at the restart would hide the climb.
    const asOne = [...settled, ...climbing].map((sample) => ({ ...sample, epoch: 0 }));
    expect(judgeGrowth(asOne, LIMIT).growing).toBe(false);
  });

  test('an epoch with too few samples is not judged', () => {
    const verdict = judgeGrowth(epoch(0, [10, 100, 200, 300]), LIMIT);
    expect(verdict).toEqual({ growing: false, lines: [] });
  });
});
