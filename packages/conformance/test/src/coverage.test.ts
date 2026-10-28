import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ACCEPTANCES_DIR,
  findRegressions,
  loadAddedAcceptances,
  parseAcceptance,
  type CoverageAcceptance,
  type CoverageReport,
} from '../../src/coverage.ts';

/** Percentage axes are held flat in these fixtures unless a test moves them. */
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

function reportOf(rowStatuses: Record<string, string>, overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    generatedAt: '2026-06-01T00:00:00.000Z',
    services: [],
    overall: { surfaceCoverage: FLAT_SURFACE, behavior: FLAT_BEHAVIOR },
    orphanObservations: [],
    highRiskUnverified: [],
    rowStatuses,
    entryPath: [],
    ...overrides,
  };
}

function acceptanceFor(rowId: string): CoverageAcceptance {
  return { rowId, path: `${ACCEPTANCES_DIR}/${rowId}.md`, text: `Retired with the legacy surface. #1417\n` };
}

function regressions(
  baseRows: Record<string, string>,
  headRows: Record<string, string>,
  acceptedRowIds: string[] = [],
): string[] {
  return findRegressions(reportOf(baseRows), reportOf(headRows), acceptedRowIds.map(acceptanceFor));
}

function surfaceAt(runtimePct: number, typesPct: number): CoverageReport['overall']['surfaceCoverage'] {
  return {
    runtime: { mapped: runtimePct, denominator: 100, pct: runtimePct },
    types: { mapped: typesPct, denominator: 100, pct: typesPct },
  };
}

describe('findRegressions: the head report against the base report', () => {
  test("a 'conforms' row demoted in the head report is a regression", () => {
    expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'bug' })).toEqual([
      "auth#2: was 'conforms', now 'bug'",
    ]);
  });

  test.each(['bug', 'diverged-documented', 'unverified', 'unsupported'])(
    "'conforms' -> '%s' is a regression",
    (status) => {
      expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': status })).toEqual([
        `auth#2: was 'conforms', now '${status}'`,
      ]);
    },
  );

  test("'bug' -> 'unverified' is not a regression", () => {
    expect(regressions({ 'firestore#1': 'bug' }, { 'firestore#1': 'unverified' })).toEqual([]);
  });

  test("'unverified' -> 'conforms' is not a regression", () => {
    expect(regressions({ 'firestore#1': 'unverified' }, { 'firestore#1': 'conforms' })).toEqual([]);
  });

  test('a brand-new row is not a regression', () => {
    expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'conforms', 'auth#3': 'bug' })).toEqual([]);
  });

  test.each(['bug', 'unverified', 'unsupported', 'diverged-documented', 'conforms'])(
    "a base '%s' row deleted from the registry is a regression",
    (status) => {
      expect(regressions({ 'firestore#1': status }, {})).toEqual([
        `firestore#1: was '${status}', row removed from the registry`,
      ]);
    },
  );

  test('every regressed row is reported, one problem each', () => {
    expect(regressions({ 'firestore#1': 'bug', 'auth#2': 'conforms' }, { 'auth#2': 'unverified' })).toEqual([
      "firestore#1: was 'bug', row removed from the registry",
      "auth#2: was 'conforms', now 'unverified'",
    ]);
  });

  test('a public surface percentage that drops is a regression, per service and overall', () => {
    const service = (pct: number): CoverageReport['services'][number] => ({
      surface: 'auth',
      kind: 'mirror',
      censusSurface: 'auth',
      surfaceCoverage: surfaceAt(pct, pct),
      behavior: FLAT_BEHAVIOR,
    });
    const base = reportOf({}, { services: [service(90)], overall: { surfaceCoverage: surfaceAt(90, 80), behavior: FLAT_BEHAVIOR } });
    const head = reportOf({}, { services: [service(89.5)], overall: { surfaceCoverage: surfaceAt(90, 79.9), behavior: FLAT_BEHAVIOR } });
    expect(findRegressions(base, head, [])).toEqual([
      'auth: public runtime surface dropped 90% -> 89.5%',
      'auth: public type surface dropped 90% -> 89.5%',
      'overall: public type surface dropped 80% -> 79.9%',
    ]);
  });

  test('a new orphan observation and more high-risk unverified rows are regressions', () => {
    const base = reportOf({}, { orphanObservations: ['old'], highRiskUnverified: ['a#1'] });
    const head = reportOf({}, { orphanObservations: ['old', 'new'], highRiskUnverified: ['a#1', 'a#2'] });
    expect(findRegressions(base, head, [])).toEqual([
      '1 NEW orphan observation(s): new',
      'high-risk unverified rows increased: 1 -> 2',
    ]);
  });

  test('an entry-path program that was green and is no longer is a regression', () => {
    const base = reportOf({}, { entryPath: [{ program: 'auth', verdict: 'green' }, { program: 'storage', verdict: 'green' }] });
    const head = reportOf({}, { entryPath: [{ program: 'auth', verdict: 'red-known' }] });
    expect(findRegressions(base, head, [])).toEqual([
      "entry-path 'auth': was green, now 'red-known' (a cliff regression, never tolerated)",
      "entry-path 'storage': was green, program removed from the corpus",
    ]);
  });
});

/**
 * Today's gate compared the head report with a committed baseline that was
 * refreshed only when some PR ran `--update-baseline`. A row that merged as
 * `conforms` without a refresh (firestore-rules#198 to #203 on 2026-10-27)
 * stayed stale in that file, so a later PR could demote it and pass. The base
 * commit's own report has no such window.
 */
describe('a stale row in the old committed baseline', () => {
  test('the base report catches the demotion the stale baseline missed', () => {
    const base = { 'firestore-rules#198': 'conforms', 'auth#2': 'conforms' };
    const head = { 'firestore-rules#198': 'bug', 'auth#2': 'conforms' };
    expect(regressions(base, head)).toEqual(["firestore-rules#198: was 'conforms', now 'bug'"]);
  });
});

describe('acceptance files: a demotion or removal the change itself accepts', () => {
  test('an acceptance file excuses a demotion off conforms', () => {
    expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'bug' }, ['auth#2'])).toEqual([]);
  });

  test('an acceptance file excuses a removal, whatever the row was', () => {
    expect(regressions({ 'firestore#1': 'bug', 'auth#2': 'conforms' }, {}, ['firestore#1', 'auth#2'])).toEqual([]);
  });

  test('an acceptance file must name a row that really regressed', () => {
    expect(regressions({ 'firestore#1': 'bug' }, { 'firestore#1': 'unverified' }, ['firestore#1'])).toEqual([
      `${ACCEPTANCES_DIR}/firestore#1.md names 'firestore#1', which did not regress against the base report`,
    ]);
  });

  test('an acceptance file for an id the base never had is reported', () => {
    expect(regressions({ 'auth#2': 'conforms' }, { 'auth#2': 'conforms' }, ['typo#404'])).toEqual([
      `${ACCEPTANCES_DIR}/typo#404.md names 'typo#404', which did not regress against the base report`,
    ]);
  });

  test('an acceptance file excuses only its own row', () => {
    expect(regressions({ 'auth#2': 'conforms', 'auth#3': 'conforms' }, { 'auth#2': 'bug', 'auth#3': 'bug' }, ['auth#2'])).toEqual([
      "auth#3: was 'conforms', now 'bug'",
    ]);
  });
});

describe('parseAcceptance', () => {
  const path = `${ACCEPTANCES_DIR}/auth#2.md`;

  test('reads the row id from the file name', () => {
    expect(parseAcceptance(path, 'Surface retired upstream. Tracked in #1417.\n')).toEqual({
      rowId: 'auth#2',
      path,
      text: 'Surface retired upstream. Tracked in #1417.\n',
    });
  });

  test('accepts an issue URL in place of #<n>', () => {
    expect(parseAcceptance(path, 'Retired. https://github.com/davideast/pyric/issues/1417\n').rowId).toBe('auth#2');
  });

  test('an empty file is refused', () => {
    expect(() => parseAcceptance(path, '  \n')).toThrow(`${path} is empty: give the reason and the issue`);
  });

  test('a file that names no issue is refused', () => {
    expect(() => parseAcceptance(path, 'Retired upstream.\n')).toThrow(`${path} names no issue: add #<n> or the issue's URL`);
  });

  test('a file that names only an issue gives no reason and is refused', () => {
    expect(() => parseAcceptance(path, '#1417\n')).toThrow(`${path} gives no reason: say why the row may regress`);
  });

  test('a file name that is not <row-id>.md is refused', () => {
    expect(() => parseAcceptance(`${ACCEPTANCES_DIR}/notes.txt`, 'Retired. #1417')).toThrow(
      `${ACCEPTANCES_DIR}/notes.txt is not named <row-id>.md`,
    );
  });
});

/**
 * Only files the change adds count. A file from an earlier merge stays as a
 * record and can never authorize a later change: the old allowlist's grants
 * had to be deleted by hand once used, or they authorized the next deletion
 * too.
 */
describe('loadAddedAcceptances: only files the change adds', () => {
  const scratch: string[] = [];

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function git(repo: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
  }

  function commitFile(repo: string, path: string, text: string): string {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
    git(repo, 'add', '--', path);
    git(repo, 'commit', '-q', '-m', `add ${path}`);
    return git(repo, 'rev-parse', 'HEAD');
  }

  function repoWithBase(): { repo: string; base: string } {
    const repo = mkdtempSync(join(tmpdir(), 'coverage-acceptances-'));
    scratch.push(repo);
    git(repo, 'init', '-q');
    commitFile(repo, `${ACCEPTANCES_DIR}/auth#2.md`, 'Accepted by an earlier merge. #1\n');
    return { repo, base: git(repo, 'rev-parse', 'HEAD') };
  }

  test('an acceptance file already on the base does not excuse a demotion', () => {
    const { repo, base } = repoWithBase();
    commitFile(repo, 'unrelated.txt', 'head change\n');
    const accepted = loadAddedAcceptances(base, repo);
    expect(accepted).toEqual([]);
    expect(findRegressions(reportOf({ 'auth#2': 'conforms' }), reportOf({ 'auth#2': 'bug' }), accepted)).toEqual([
      "auth#2: was 'conforms', now 'bug'",
    ]);
  });

  test('an acceptance file the change adds excuses its demotion', () => {
    const { repo, base } = repoWithBase();
    commitFile(repo, `${ACCEPTANCES_DIR}/auth#3.md`, 'Upstream changed the contract. #1417\n');
    const accepted = loadAddedAcceptances(base, repo);
    expect(accepted.map((a) => a.rowId)).toEqual(['auth#3']);
    expect(findRegressions(reportOf({ 'auth#3': 'conforms' }), reportOf({ 'auth#3': 'bug' }), accepted)).toEqual([]);
  });

  test('editing an acceptance file already on the base does not renew it', () => {
    const { repo, base } = repoWithBase();
    commitFile(repo, `${ACCEPTANCES_DIR}/auth#2.md`, 'Accepted again. #1417\n');
    expect(loadAddedAcceptances(base, repo)).toEqual([]);
  });

  test('an added file that is not a valid acceptance fails loudly', () => {
    const { repo, base } = repoWithBase();
    commitFile(repo, `${ACCEPTANCES_DIR}/auth#4.md`, 'No issue named.\n');
    expect(() => loadAddedAcceptances(base, repo)).toThrow(`${ACCEPTANCES_DIR}/auth#4.md names no issue`);
  });
});
