import { describe, expect, test } from 'bun:test';
import { firstMismatch, normalizeTrace, type Mismatch, type Trace } from './compare.js';
import { knownDivergence } from './known-divergences.js';
import type { Sequence } from './sequence.js';
import { canonicalizeReadValue, SERVER_TIMESTAMP_FLOOR_SECONDS } from './value-serialize.js';

function emptyTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    seed: 1,
    steps: [],
    events: {},
    clientData: [],
    adminData: {},
    bundleData: {},
    anonymousUids: [],
    autoIds: [],
    ...overrides,
  };
}

describe('Firestore differential trace normalization and comparison', () => {
  test('replaces anonymous UIDs and addDoc auto IDs in mint order across steps, events, and dumps', () => {
    const sandbox = normalizeTrace(emptyTrace({
      steps: [{ ok: { uid: 'anon-sbx-111', path: 'orgs/o1/logs/autoSbxAAA1111111111' } }],
      events: { L0: [{ id: 'autoSbxAAA1111111111', owner: 'anon-sbx-111' }] },
      adminData: { 'orgs/o1/logs/autoSbxAAA1111111111': { by: 'anon-sbx-111' } },
      bundleData: { 'orgs/o1/logs/autoSbxAAA1111111111': { by: 'anon-sbx-111' } },
      anonymousUids: ['anon-sbx-111'],
      autoIds: ['autoSbxAAA1111111111'],
    }));
    const hosted = normalizeTrace(emptyTrace({
      steps: [{ ok: { uid: 'anon-hst-999', path: 'orgs/o1/logs/autoHstZZZ9999999999' } }],
      events: { L0: [{ id: 'autoHstZZZ9999999999', owner: 'anon-hst-999' }] },
      adminData: { 'orgs/o1/logs/autoHstZZZ9999999999': { by: 'anon-hst-999' } },
      bundleData: { 'orgs/o1/logs/autoHstZZZ9999999999': { by: 'anon-hst-999' } },
      anonymousUids: ['anon-hst-999'],
      autoIds: ['autoHstZZZ9999999999'],
    }));

    expect(firstMismatch({ sandbox, hosted })).toBeNull();
  });

  test('distinguishes -0, 0, NaN, +-Infinity, Bytes, GeoPoint, Timestamp, and serverTimestamp', () => {
    expect(canonicalizeReadValue(-0)).not.toEqual(canonicalizeReadValue(0));
    expect(canonicalizeReadValue(Number.NaN)).not.toEqual(canonicalizeReadValue(null));
    expect(canonicalizeReadValue(Number.POSITIVE_INFINITY)).not.toEqual(canonicalizeReadValue(Number.NEGATIVE_INFINITY));

    const userTs = canonicalizeReadValue({
      seconds: 1_650_000_000,
      nanoseconds: 500,
      toMillis: () => 1_650_000_000_000,
    });
    const serverTsA = canonicalizeReadValue({
      seconds: SERVER_TIMESTAMP_FLOOR_SECONDS + 10,
      nanoseconds: 111,
      toMillis: () => 0,
    });
    const serverTsB = canonicalizeReadValue({
      seconds: SERVER_TIMESTAMP_FLOOR_SECONDS + 99,
      nanoseconds: 888,
      toMillis: () => 0,
    });

    expect(serverTsA).toEqual(serverTsB);
    expect(userTs).not.toEqual(serverTsA);
  });

  test('flags bundle round-trip divergence even if both planes agreed on steps', () => {
    const sandbox = normalizeTrace(emptyTrace({
      adminData: { 'items/i1': { n: 1 } },
      bundleData: { 'items/i1': { n: 1 } },
    }));
    const hosted = normalizeTrace(emptyTrace({
      adminData: { 'items/i1': { n: 1 } },
      bundleData: { 'items/i1': { n: 2 } },
    }));

    const mismatch = firstMismatch({ sandbox, hosted });
    expect(mismatch).not.toBeNull();
    expect(mismatch?.where).toBe('bundleRoundTrip.hosted');
  });

  test('errored-listener-rules-reload matches only when an active listener sees a rules step before unlisten', () => {
    const mismatch: Mismatch = {
      where: 'events.L2 listenDoc(db0, items/i1)',
      values: {
        sandbox: [
          { kind: 'error', error: 'code=permission-denied' },
          { kind: 'doc', exists: true, data: { n: 1 } },
        ],
        hosted: [
          { kind: 'error', error: 'code=permission-denied' },
        ],
      },
    };

    const withActiveRulesReload: Sequence = {
      seed: 1,
      initialRules: 1,
      steps: [
        { op: 'listenDoc', id: 2, db: 0, path: 'items/i1' },
        { op: 'rules', rules: 0 },
        { op: 'unlisten', id: 2 },
      ],
    };
    expect(knownDivergence(mismatch, withActiveRulesReload)?.name).toBe('errored-listener-rules-reload');

    const withoutRulesReload: Sequence = {
      seed: 1,
      initialRules: 1,
      steps: [
        { op: 'listenDoc', id: 2, db: 0, path: 'items/i1' },
        { op: 'setDoc', db: 0, path: 'items/i1', data: { n: 1 }, mode: { kind: 'replace' } },
      ],
    };
    expect(knownDivergence(mismatch, withoutRulesReload)).toBeUndefined();

    const rulesOnlyBeforeAttach: Sequence = {
      seed: 1,
      initialRules: 1,
      steps: [
        { op: 'rules', rules: 0 },
        { op: 'listenDoc', id: 2, db: 0, path: 'items/i1' },
        { op: 'setDoc', db: 0, path: 'items/i1', data: { n: 1 }, mode: { kind: 'replace' } },
      ],
    };
    expect(knownDivergence(mismatch, rulesOnlyBeforeAttach)).toBeUndefined();

    const rulesOnlyAfterUnlisten: Sequence = {
      seed: 1,
      initialRules: 1,
      steps: [
        { op: 'listenQuery', id: 2, db: 0, query: { source: { kind: 'collection', path: 'items' } } },
        { op: 'unlisten', id: 2 },
        { op: 'rules', rules: 0 },
      ],
    };
    expect(knownDivergence(mismatch, rulesOnlyAfterUnlisten)).toBeUndefined();
  });
});
