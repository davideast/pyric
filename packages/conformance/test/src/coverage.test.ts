import { describe, expect, test } from 'bun:test';
import {
  findRegressions,
  loadRowRemovalAllowlist,
  type Baseline,
  type CoverageReport,
  type RowRemovalAllowlist,
} from '../../src/coverage.ts';

/** Percentage axes are held flat in these fixtures — the row-status axis is what is under test. */
const FLAT_SURFACE = {
  runtime: { mapped: 0, denominator: 0, pct: 0 },
  types: { mapped: 0, denominator: 0, pct: 0 },
};

const FLAT_BEHAVIOR = {
  conforms: 0,
  divergedDocumented: 0,
  bug: 0,
  unsupported: 0,
  unverified: 0,
  total: { denominator: 0, pct: 0 },
  intended: { denominator: 0, pct: 0 },
};

function baselineOf(rowStatuses: Record<string, string>): Baseline {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    services: {},
    overall: { publicSurface: FLAT_SURFACE },
    rowStatuses,
    highRiskUnverified: [],
    orphanObservations: [],
    entryPathVerdicts: {},
  };
}

function reportOf(rowStatuses: Record<string, string>): CoverageReport {
  return {
    generatedAt: '2026-06-01T00:00:00.000Z',
    services: [],
    overall: { surfaceCoverage: FLAT_SURFACE, behavior: FLAT_BEHAVIOR },
    orphanObservations: [],
    highRiskUnverified: [],
    rowStatuses,
    entryPath: [],
  };
}

function regressions(
  baselineRows: Record<string, string>,
  currentRows: Record<string, string>,
  allowlist: RowRemovalAllowlist = {},
): string[] {
  return findRegressions(baselineOf(baselineRows), reportOf(currentRows), allowlist);
}

describe('findRegressions — registry row deletions', () => {
  test("a baseline 'bug' row deleted from the registry is a regression (denominator manipulation)", () => {
    const problems = regressions({ 'firestore#1': 'bug', 'auth#2': 'conforms' }, { 'auth#2': 'conforms' });
    expect(problems).toEqual(["firestore#1: was 'bug', row removed from the registry"]);
  });

  test.each(['unverified', 'unsupported', 'diverged-documented'])(
    "a baseline '%s' row deleted from the registry is a regression",
    (status) => {
      const problems = regressions({ 'firestore#1': status }, {});
      expect(problems).toEqual([`firestore#1: was '${status}', row removed from the registry`]);
    },
  );

  test("a baseline 'conforms' row deleted from the registry is still a regression", () => {
    const problems = regressions({ 'auth#2': 'conforms' }, {});
    expect(problems).toEqual(["auth#2: was 'conforms', row removed from the registry"]);
  });

  test('every deleted baseline row is reported, one problem each', () => {
    const problems = regressions({ 'firestore#1': 'bug', 'auth#2': 'unverified' }, {});
    expect(problems).toEqual([
      "firestore#1: was 'bug', row removed from the registry",
      "auth#2: was 'unverified', row removed from the registry",
    ]);
  });
});

describe('findRegressions — row status transitions (unchanged semantics)', () => {
  test("'bug' -> 'unverified' is not a regression", () => {
    expect(regressions({ 'firestore#1': 'bug' }, { 'firestore#1': 'unverified' })).toEqual([]);
  });

  test("'unverified' -> 'conforms' is not a regression", () => {
    expect(regressions({ 'firestore#1': 'unverified' }, { 'firestore#1': 'conforms' })).toEqual([]);
  });

  test("'conforms' -> 'bug' is still a regression", () => {
    expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'bug' })).toEqual([
      "auth#2: was 'conforms', now 'bug'",
    ]);
  });

  test('a brand-new row is not a regression', () => {
    expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'conforms', 'auth#3': 'bug' })).toEqual([]);
  });
});

describe('findRegressions — removal allowlist (the reviewed escape hatch)', () => {
  test("an allowlisted 'bug' row may be deleted", () => {
    const problems = regressions({ 'firestore#1': 'bug' }, {}, { 'firestore#1': { reason: 'row folded into firestore#9' } });
    expect(problems).toEqual([]);
  });

  test("an allowlisted 'conforms' row may be deleted — the allowlist is explicit and reviewed", () => {
    const problems = regressions({ 'auth#2': 'conforms' }, {}, { 'auth#2': { reason: 'surface retired' } });
    expect(problems).toEqual([]);
  });

  test('an allowlist entry never excuses a status flip off conforms', () => {
    const problems = regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'bug' }, { 'auth#2': { reason: 'surface retired' } });
    expect(problems).toEqual(["auth#2: was 'conforms', now 'bug'"]);
  });

  test('an allowlist entry for a row that is still present changes nothing', () => {
    const problems = regressions({ 'firestore#1': 'bug' }, { 'firestore#1': 'bug' }, { 'firestore#1': { reason: 'planned' } });
    expect(problems).toEqual([]);
  });

  test('an empty allowlist permits no removals', () => {
    expect(regressions({ 'firestore#1': 'bug' }, {}, {})).toEqual([
      "firestore#1: was 'bug', row removed from the registry",
    ]);
  });
});

describe('loadRowRemovalAllowlist — committed file', () => {
  test('loads, and every entry carries a non-empty reason', () => {
    const allowlist = loadRowRemovalAllowlist();
    for (const [id, entry] of Object.entries(allowlist)) {
      expect(typeof id).toBe('string');
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
