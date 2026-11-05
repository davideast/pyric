import { describe, expect, test } from 'bun:test';
import {
  ACTIONS_BETWEEN_RESTARTS,
  ACTIONS_PER_MINUTE,
  ActionLog,
  DEFAULT_MINUTES,
  DEFAULT_SEED,
  growingHeapTypes,
  growingRetainers,
  heapTypes,
  summarizeHeap,
  judgeGrowth,
  judgeLevelOff,
  latencyReport,
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
    expect(settings).toEqual({
      seed: DEFAULT_SEED, minutes: DEFAULT_MINUTES, checkpointMs: 180_000, sampleMs: 30_000, pageSampleMs: 5_000, firstRestartAction: 3960,
    });
  });

  test('a short run checks six times', () => {
    expect(soakSettings({ SOAK_MINUTES: '2' })).toMatchObject({ minutes: 2, checkpointMs: 20_000, sampleMs: 5_000, pageSampleMs: 5_000 });
  });

  test('no restart comes before 60% of the run, or before the usual gap between restarts', () => {
    expect(soakSettings({ SOAK_MINUTES: '60' }).firstRestartAction).toBe(Math.round(60 * 0.6 * ACTIONS_PER_MINUTE));
    expect(soakSettings({ SOAK_MINUTES: '5' }).firstRestartAction).toBe(ACTIONS_BETWEEN_RESTARTS);
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

  test('records how long each action took, and the latency report ranks the slow ones', () => {
    const log = new ActionLog();
    log.add('set post', 'p0');
    log.add('read post', 'p0');
    log.entries[0]!.ms = 25_000;
    log.entries[1]!.ms = 40;
    expect(log.text()).toContain('set post p0 (25000 ms)');
    const report = latencyReport(log.entries, 1);
    expect(report[0]).toBe('set post: 1 actions, median 25000 ms, slowest 25000 ms');
    expect(report[1]).toBe('read post: 1 actions, median 40 ms, slowest 40 ms');
    expect(report.slice(2)).toEqual(['the 1 slowest actions:', expect.stringContaining('#0 ')]);
  });

  test('finish sets the time an action took', () => {
    const log = new ActionLog();
    const index = log.add('pause');
    log.finish(index);
    expect(log.entries[0]!.ms).toBeGreaterThanOrEqual(0);
  });
});

/** A V8 heap snapshot with only the fields heapTypes reads, one node per [type, name, self_size]. */
function snapshotOf(nodes: Array<[string, string, number]>): string {
  const types = ['hidden', 'object', 'closure', 'string'];
  const strings = [...new Set(nodes.map(([, name]) => name))];
  return JSON.stringify({
    snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size'], node_types: [types] } },
    nodes: nodes.flatMap(([type, name, size], id) => [types.indexOf(type), strings.indexOf(name), id, size]),
    strings,
  });
}

describe('heapTypes and growingHeapTypes', () => {
  test('sum nodes by constructor, closure name, or type, and rank what grew', () => {
    const before = heapTypes(snapshotOf([['object', 'Listener', 100], ['closure', 'onSnapshot', 40], ['string', 'abc', 8]]));
    expect(before.get('Listener')).toEqual({ name: 'Listener', count: 1, bytes: 100 });
    expect(before.get('closure onSnapshot')).toEqual({ name: 'closure onSnapshot', count: 1, bytes: 40 });
    expect(before.get('(string)')).toEqual({ name: '(string)', count: 1, bytes: 8 });
    const after = heapTypes(snapshotOf([
      ['object', 'Listener', 100], ['object', 'Listener', 100], ['object', 'Listener', 100],
      ['closure', 'onSnapshot', 40], ['string', 'abcdef', 16],
    ]));
    expect(growingHeapTypes(before, after, 5)).toEqual([
      { name: 'Listener', count: 3, bytes: 300, countGrowth: 2, bytesGrowth: 200 },
      { name: '(string)', count: 1, bytes: 16, countGrowth: 0, bytesGrowth: 8 },
    ]);
  });
});

describe('summarizeHeap retainers', () => {
  /** A snapshot of one Store holding `count` Listener objects under ids, plus a hidden-class edge per Listener. */
  function store(count: number): string {
    const types = ['hidden', 'object'];
    const edgeTypes = ['property', 'element', 'internal', 'weak'];
    const strings = ['Store', 'Listener', '(map)', 'map', ...Array.from({ length: count }, (_, i) => `doc${i}`)];
    const nodes = [1, 0, 0, 10, count, 0, 2, 1, 0, 0];
    const edges: number[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push(1, 1, i + 2, 20, 1);
      edges.push(0, 4 + i, (i + 2) * 5);
    }
    for (let i = 0; i < count; i += 1) edges.push(2, 3, 5);
    // The Listener's map edges come after the Store's, in node order.
    return JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
          node_types: [types],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [edgeTypes],
        },
      },
      nodes,
      edges,
      strings,
    });
  }

  test('count references to app objects by holder and property, with ids folded', () => {
    const before = summarizeHeap(store(2));
    const after = summarizeHeap(store(5));
    expect(growingRetainers(before.retainers, after.retainers, 5)).toEqual([
      { path: 'Listener <- Store.doc<id>', count: 5, growth: 3 },
    ]);
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
    expect(verdict.lines[1]).toMatch(/^epoch 0: 9 samples, .* steady growth$/);
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

  test('an epoch with too few samples is not judged, and the report says so', () => {
    const verdict = judgeGrowth(epoch(0, [10, 100, 200, 300]), LIMIT);
    expect(verdict).toEqual({
      growing: false, judged: 0, epochs: 1,
      lines: ['0 of 1 epochs judged', 'epoch 0: not judged, 4 samples over 90s (needs 7)'],
    });
  });

  test('a page leaking 100 MB a minute and reloading every 2 minutes fails when sampled every 5 seconds', () => {
    const loads = [0, 1, 2].flatMap((load) =>
      Array.from({ length: 24 }, (_, i) => ({ at: load * 120 + i * 5, epoch: load, bytes: (10 + (i * 5 * 100) / 60) * MB })));
    const verdict = judgeGrowth(loads, { floorBytes: 48 * MB, ratio: 1, minSamples: 5 });
    expect(verdict.judged).toBe(3);
    expect(verdict.growing).toBe(true);
  });
});

describe('judgeLevelOff', () => {
  const LEVEL: { minMinutes: number; maxBytesPerMinute: number } = { minMinutes: 10, maxBytesPerMinute: 1 * MB };
  /** Samples every 30 s for `minutes`, at `level(minute)` MB. */
  function series(minutes: number, level: (minute: number) => number): MemorySample[] {
    return Array.from({ length: minutes * 2 + 1 }, (_, i) => ({ at: i * 30, epoch: 0, bytes: level(i / 2) * MB }));
  }

  test('a history that fills its cap and holds passes', () => {
    const capped = series(36, (minute) => 80 + Math.min(minute, 8) * 1.5 + (minute % 2));
    const verdict = judgeLevelOff(capped, LEVEL);
    expect(verdict.judged).toBe(1);
    expect(verdict.growing).toBe(false);
  });

  test('a history with no cap fails at 1.5 MB a minute, the rate the soak measured before any cap', () => {
    const verdict = judgeLevelOff(series(36, (minute) => 80 + minute * 1.5), LEVEL);
    expect(verdict.growing).toBe(true);
    expect(verdict.lines[1]).toMatch(/^epoch 0: 36\.0 min, second half 1\.5 MB\/min over \d+ samples, spread .* still climbing$/);
  });

  test('a short epoch is not judged, and the report says so', () => {
    const verdict = judgeLevelOff(series(6, (minute) => 80 + minute * 10), LEVEL);
    expect(verdict).toMatchObject({ growing: false, judged: 0, epochs: 1 });
    expect(verdict.lines[1]).toBe('epoch 0: not judged, 6.0 min (needs 10)');
  });
});
