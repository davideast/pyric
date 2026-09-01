import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(problems).toEqual([
      "auth#2: was 'conforms', now 'bug'",
      "allowlist entry 'auth#2' is stale: row present in registry",
    ]);
  });

  test('an empty allowlist permits no removals', () => {
    expect(regressions({ 'firestore#1': 'bug' }, {}, {})).toEqual([
      "firestore#1: was 'bug', row removed from the registry",
    ]);
  });
});

/**
 * A grant is spent when its removal lands. Leaving it in the file turns a
 * one-time, reviewed deletion into a permanent licence to delete that row
 * again — including a row someone re-added in the meantime, whose second
 * deletion no reviewer ever saw.
 */
describe('findRegressions — allowlist entries must be exercised, not standing', () => {
  test('an entry for a row that is still in the registry is stale', () => {
    const problems = regressions({ 'firestore#1': 'bug' }, { 'firestore#1': 'bug' }, { 'firestore#1': { reason: 'planned' } });
    expect(problems).toEqual(["allowlist entry 'firestore#1' is stale: row present in registry"]);
  });

  test('an entry for a row that was removed and later re-added is stale', () => {
    const problems = regressions(
      { 'firestore#1': 'bug' },
      { 'firestore#1': 'conforms' },
      { 'firestore#1': { reason: 'row folded into firestore#9' } },
    );
    expect(problems).toEqual(["allowlist entry 'firestore#1' is stale: row present in registry"]);
  });

  test('an entry naming an id the baseline never had is stale', () => {
    const problems = regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'conforms' }, { 'typo#404': { reason: 'mis-typed id' } });
    expect(problems).toEqual(["allowlist entry 'typo#404' is stale: id not in baseline"]);
  });

  test('an entry unknown to both baseline and registry reports both faults', () => {
    const problems = regressions({}, { 'ghost#1': 'bug' }, { 'ghost#1': { reason: 'stale grant' } });
    expect(problems).toEqual([
      "allowlist entry 'ghost#1' is stale: row present in registry",
      "allowlist entry 'ghost#1' is stale: id not in baseline",
    ]);
  });

  test('an entry that is actually being exercised right now is clean', () => {
    expect(regressions({ 'firestore#1': 'bug' }, {}, { 'firestore#1': { reason: 'row folded into firestore#9' } })).toEqual([]);
  });

  test('every stale entry is reported, one problem each', () => {
    const problems = regressions(
      { 'firestore#1': 'bug', 'auth#2': 'conforms' },
      { 'firestore#1': 'bug', 'auth#2': 'conforms' },
      { 'firestore#1': { reason: 'planned' }, 'auth#2': { reason: 'planned' } },
    );
    expect(problems).toEqual([
      "allowlist entry 'firestore#1' is stale: row present in registry",
      "allowlist entry 'auth#2' is stale: row present in registry",
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

  test('the committed allowlist is empty — no removal is currently granted', () => {
    expect(loadRowRemovalAllowlist()).toEqual({});
  });
});

describe('loadRowRemovalAllowlist — malformed input', () => {
  const scratch: string[] = [];

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function allowlistFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'row-removal-allowlist-'));
    scratch.push(dir);
    const path = join(dir, 'row-removal-allowlist.json');
    writeFileSync(path, contents);
    return path;
  }

  test('malformed JSON names the offending file instead of throwing a bare SyntaxError', () => {
    const path = allowlistFile('{ "firestore#1": { "reason": "oops", }\n');
    expect(() => loadRowRemovalAllowlist(path)).toThrow(path);
    expect(() => loadRowRemovalAllowlist(path)).toThrow(/not valid JSON/);
  });

  test('an entry without a reason is still rejected', () => {
    const path = allowlistFile('{ "firestore#1": { "reason": "  " } }');
    expect(() => loadRowRemovalAllowlist(path)).toThrow(/needs a non-empty reason/);
  });

  test('an absent file grants nothing', () => {
    expect(loadRowRemovalAllowlist(join(tmpdir(), 'no-such-row-removal-allowlist.json'))).toEqual({});
  });
});
