import { describe, it, expect } from 'bun:test';
import {
  bucketBillableMetrics,
  bucketRulesMetrics,
  classifyBillable,
  classifyRules,
  isAdminEvent,
  useBillableMetrics,
  useRulesMetrics,
} from '../../../src/traffic/hooks/useTrafficMetrics.js';
import type { TimeWindow } from '../../../src/traffic/hooks/useTrafficBuckets.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';
import { evt } from '../helpers/fake-source.js';

const WINDOW: TimeWindow = { start: 0, end: 1000 };

describe('classifyBillable', () => {
  it('maps get + list to reads', () => {
    expect(classifyBillable(evt({ method: 'get', result: 'allow' }))).toBe('reads');
    expect(classifyBillable(evt({ method: 'list', result: 'allow' }))).toBe('reads');
  });

  it('maps create + update + set to writes', () => {
    expect(classifyBillable(evt({ method: 'create', result: 'allow' }))).toBe('writes');
    expect(classifyBillable(evt({ method: 'update', result: 'allow' }))).toBe('writes');
    expect(classifyBillable(evt({ method: 'set', result: 'allow' }))).toBe('writes');
  });

  it('maps delete + remove to deletes', () => {
    expect(classifyBillable(evt({ method: 'delete', result: 'allow' }))).toBe('deletes');
    expect(classifyBillable(evt({ method: 'remove', result: 'allow' }))).toBe('deletes');
  });

  it('never bills a denied, errored, unsupported, or not-applicable op', () => {
    for (const result of ['deny', 'error', 'unsupported', 'not-applicable'] as const) {
      expect(classifyBillable(evt({ method: 'get', result }))).toBeNull();
    }
  });

  it('bills an admin (rules-bypassed) op even without an allow result', () => {
    expect(
      classifyBillable(evt({ method: 'get', result: 'not-applicable', origin: 'admin' })),
    ).toBe('reads');
  });

  it('returns null for a method with no billable mapping', () => {
    expect(classifyBillable(evt({ method: 'listen', result: 'allow' }))).toBeNull();
  });

  it('accepts a custom isAdmin predicate', () => {
    const isAdmin = () => true;
    expect(classifyBillable(evt({ method: 'get', result: 'error' }), isAdmin)).toBe('reads');
  });
});

describe('classifyRules', () => {
  it('maps allow/deny/error results', () => {
    expect(classifyRules(evt({ result: 'allow' }))).toBe('allows');
    expect(classifyRules(evt({ result: 'deny' }))).toBe('denies');
    expect(classifyRules(evt({ result: 'error' }))).toBe('errors');
  });

  it('excludes unsupported and not-applicable results', () => {
    expect(classifyRules(evt({ result: 'unsupported' }))).toBeNull();
    expect(classifyRules(evt({ result: 'not-applicable' }))).toBeNull();
  });

  it('excludes admin (rules-bypassed) ops even when result is allow', () => {
    expect(classifyRules(evt({ result: 'allow', origin: 'admin' }))).toBeNull();
  });

  it('accepts a custom isAdmin predicate', () => {
    const isAdmin = () => true;
    expect(classifyRules(evt({ result: 'allow' }), isAdmin)).toBeNull();
  });
});

describe('isAdminEvent', () => {
  it('is true only for origin admin', () => {
    expect(isAdminEvent(evt({ origin: 'admin' }))).toBe(true);
    expect(isAdminEvent(evt({ origin: 'user' }))).toBe(false);
  });
});

describe('bucketBillableMetrics', () => {
  it('returns zeroed series for an empty buffer', () => {
    const r = bucketBillableMetrics([], WINDOW, 10);
    expect(r.points.length).toBe(10);
    expect(r.series.map((s) => s.key)).toEqual(['reads', 'writes', 'deletes']);
    expect(r.series.every((s) => s.total === 0)).toBe(true);
    expect(r.maxValue).toBe(0);
  });

  it('returns an empty result for a zero-width window or non-positive bucketCount', () => {
    expect(bucketBillableMetrics([evt({ at: 5 })], { start: 5, end: 5 }, 10).points).toEqual([]);
    expect(bucketBillableMetrics([evt({ at: 5 })], WINDOW, 0).points).toEqual([]);
  });

  it('buckets reads/writes/deletes by timestamp and totals them', () => {
    const events = [
      evt({ at: 50, method: 'get', result: 'allow' }),
      evt({ at: 60, method: 'list', result: 'allow' }),
      evt({ at: 150, method: 'set', result: 'allow' }),
      evt({ at: 950, method: 'delete', result: 'allow' }),
      evt({ at: 55, method: 'get', result: 'deny' }), // never bills
    ];
    const r = bucketBillableMetrics(events, WINDOW, 10);
    const reads = r.series.find((s) => s.key === 'reads')!;
    const writes = r.series.find((s) => s.key === 'writes')!;
    const deletes = r.series.find((s) => s.key === 'deletes')!;
    expect(reads.values[0]).toBe(2);
    expect(reads.total).toBe(2);
    expect(writes.values[1]).toBe(1);
    expect(writes.total).toBe(1);
    expect(deletes.values[9]).toBe(1);
    expect(deletes.total).toBe(1);
    expect(r.maxValue).toBe(2);
  });

  it('drops events outside the window from every series', () => {
    const events = [evt({ at: -5, method: 'get', result: 'allow' }), evt({ at: 5000, method: 'get', result: 'allow' })];
    const r = bucketBillableMetrics(events, WINDOW, 10);
    expect(r.series.every((s) => s.total === 0)).toBe(true);
  });
});

describe('bucketRulesMetrics', () => {
  it('buckets allows/denies/errors and excludes admin + unsupported', () => {
    const events = [
      evt({ at: 50, result: 'allow' }),
      evt({ at: 60, result: 'deny' }),
      evt({ at: 70, result: 'error' }),
      evt({ at: 80, result: 'unsupported' }),
      evt({ at: 90, result: 'allow', origin: 'admin' }),
    ];
    const r = bucketRulesMetrics(events, WINDOW, 10);
    const allows = r.series.find((s) => s.key === 'allows')!;
    const denies = r.series.find((s) => s.key === 'denies')!;
    const errors = r.series.find((s) => s.key === 'errors')!;
    expect(allows.total).toBe(1);
    expect(denies.total).toBe(1);
    expect(errors.total).toBe(1);
  });
});

describe('useBillableMetrics', () => {
  it('reacts to the events + window it is given', async () => {
    const events = [evt({ at: 150, method: 'get', result: 'allow' })];
    const { result } = renderHook(() =>
      useBillableMetrics({ events, window: WINDOW, bucketCount: 10 }),
    );
    await waitFor(() =>
      expect(result.current.series.find((s) => s.key === 'reads')!.total).toBe(1),
    );
  });

  it('defaults to 24 buckets', async () => {
    const { result } = renderHook(() => useBillableMetrics({ events: [], window: WINDOW }));
    await waitFor(() => expect(result.current.points.length).toBe(24));
  });
});

describe('useRulesMetrics', () => {
  it('reacts to the events + window it is given', async () => {
    const events = [evt({ at: 150, result: 'deny' })];
    const { result } = renderHook(() =>
      useRulesMetrics({ events, window: WINDOW, bucketCount: 10 }),
    );
    await waitFor(() =>
      expect(result.current.series.find((s) => s.key === 'denies')!.total).toBe(1),
    );
  });
});
