import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type Commit,
  formatReport,
  isInsideBoundary,
  measure,
  parseLog,
  readCommits,
  resolveWindow,
} from './rules-boundary-report.ts';

function commit(hash: string, paths: string[]): Commit {
  return { hash, date: '2026-10-28', subject: `subject ${hash}`, paths };
}

describe('parseLog', () => {
  test('reads hash, date, subject and every path of each record', () => {
    const output = [
      '\x1eaaa\x1f2026-10-28\x1ffix(rules): one\0\npackages/rules/src/a.ts\0packages/cli/src/b.ts\0',
      '\x1ebbb\x1f2026-10-27\x1ffeat: two\0\npackages/rules/src/c.ts\0',
    ].join('');
    expect(parseLog(output)).toEqual([
      { hash: 'aaa', date: '2026-10-28', subject: 'fix(rules): one', paths: ['packages/rules/src/a.ts', 'packages/cli/src/b.ts'] },
      { hash: 'bbb', date: '2026-10-27', subject: 'feat: two', paths: ['packages/rules/src/c.ts'] },
    ]);
  });

  test('keeps a path exactly as git wrote it, apart from the newline after the header', () => {
    expect(parseLog('\x1eaaa\x1f2026-10-28\x1ffix: spaces\0\n packages/odd name.ts \0')[0]?.paths).toEqual([' packages/odd name.ts ']);
  });

  test('reads empty output as no commits and rejects a truncated header', () => {
    expect(parseLog('')).toEqual([]);
    expect(() => parseLog('\x1eaaa\x1f2026-10-28\0\npath\0')).toThrow('incomplete log record');
  });
});

describe('isInsideBoundary', () => {
  test('holds the package-to-be and the rules conformance data', () => {
    for (const path of [
      'packages/rules/src/simulator/handler.ts',
      'packages/rules/test/boundary.test.ts',
      'packages/rules/bench/eval.bench.ts',
      'packages/conformance/rules-corpus/firestore/case.json',
      'packages/conformance/rules-language/firestore.json',
      'packages/conformance/observations/storage-rules/capture.json',
      'packages/conformance/registry/rules.ts',
      'packages/conformance/assurance-node-counts/rtdb-rules/1600.json',
      'packages/conformance/assurance-node-counts/rules/base.json',
    ]) {
      expect({ path, inside: isInsideBoundary(path) }).toEqual({ path, inside: true });
    }
  });

  test('leaves out the rest of pyric and the other conformance data', () => {
    for (const path of [
      'packages/pyric/src/storage/sandbox/rules-evaluator.ts',
      'packages/pyric/src/rules-tools/tools.ts',
      'packages/pyric/test/database/sandbox/rules-eval.test.ts',
      'packages/conformance/baselines/firestore-rules-scorecard.json',
      'packages/conformance/observations/rtdb/capture.json',
      'packages/conformance/registry/rtdb.ts',
      'packages/conformance/assurance-node-counts/rtdb/base.json',
      'packages/site-docs/src/content/secure/simulate-and-lint.md',
    ]) {
      expect({ path, inside: isInsideBoundary(path) }).toEqual({ path, inside: false });
    }
  });
});

describe('measure and formatReport', () => {
  const commits = [
    commit('a'.repeat(40), ['packages/rules/src/a.ts', 'packages/pyric/test/rules/a.test.ts']),
    commit('b'.repeat(40), ['packages/rules/src/b.ts', 'packages/cli/src/b.ts', 'packages/conformance/registry/rules.ts']),
    commit('c'.repeat(40), ['packages/rules/src/c.ts']),
    commit('d'.repeat(40), ['packages/rules/src/d.ts']),
    commit('e'.repeat(40), ['packages/rules/src/e.ts']),
    commit('f'.repeat(40), ['packages/rules/src/f.ts']),
  ];
  const reportWindow = { ref: 'origin/main', head: '1'.repeat(40), since: '2026-10-01T00:00:00', until: '2026-10-30T23:59:59' };

  test('counts a commit as crossing when any path is outside, and keeps only those paths', () => {
    const result = measure(commits);
    expect(result.total).toBe(6);
    expect(result.crossings.map(({ commit: { hash }, outside }) => ({ hash: hash[0], outside }))).toEqual([
      { hash: 'b', outside: ['packages/cli/src/b.ts'] },
    ]);
  });

  test('prints the figure, the verdict and each crossing commit with its paths', () => {
    expect(formatReport(measure(commits), reportWindow)).toContain([
      '1 of 6 commits (16.7%) also touch paths outside the boundary.',
      'The test is fewer than 1 in 5: this window meets the split test.',
      '',
      'bbbbbbbbb 2026-10-28 subject bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '  packages/cli/src/b.ts',
      '',
    ].join('\n'));
  });

  test('fails the test at exactly 1 in 5 and on an empty window', () => {
    const atThreshold = measure(commits.slice(1));
    expect(formatReport(atThreshold, reportWindow)).toContain('1 of 5 commits (20.0%) also touch');
    expect(formatReport(atThreshold, reportWindow)).toContain('this window does not meet the split test');
    expect(formatReport(measure([]), reportWindow)).toContain('0 of 0 commits (0.0%)');
    expect(formatReport(measure([]), reportWindow)).toContain('this window does not meet the split test');
  });
});

describe('the report against a real repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rules-boundary-report-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function git(args: string[], date = '2026-10-15T12:00:00Z'): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }
  function commitFiles(message: string, files: Record<string, string>, date?: string): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], date);
  }

  git(['init', '-q', '-b', 'main']);
  commitFiles('chore: seed', { 'packages/rules/src/a.ts': '1', 'packages/pyric/src/sandbox/s.ts': '1' }, '2026-09-01T12:00:00Z');
  commitFiles('fix(rules): early on the first day in UTC', { 'packages/rules/src/a.ts': '1b' }, '2026-10-01T03:00:00Z');
  commitFiles('fix(rules): inside only', { 'packages/rules/src/a.ts': '2', 'packages/pyric/test/rules/a.test.ts': '2' }, '2026-10-10T12:00:00Z');
  commitFiles('fix(rules): crosses into sandbox', { 'packages/rules/src/a.ts': '3', 'packages/pyric/src/sandbox/s.ts': '3' }, '2026-10-12T12:00:00Z');
  commitFiles('fix(sandbox): outside only', { 'packages/pyric/src/sandbox/s.ts': '4' }, '2026-10-13T12:00:00Z');
  git(['checkout', '-q', '-b', 'topic']);
  git(['mv', 'packages/pyric/src/sandbox/s.ts', 'packages/rules/src/s.ts']);
  git(['commit', '-q', '-m', 'refactor: move s into rules'], '2026-10-14T12:00:00Z');
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '-m', 'Merge topic', 'topic']);
  commitFiles('fix(rules): after the window', { 'packages/rules/src/a.ts': '5', 'packages/cli/c.ts': '5' }, '2026-11-20T12:00:00Z');

  test('counts non-merge commits in the window that touch the engine, with both sides of a rename', () => {
    const reportWindow = resolveWindow(['--ref=main', '--since=2026-10-01', '--until=2026-10-31'], repo);
    const result = measure(readCommits(reportWindow, repo));
    expect(result.total).toBe(4);
    expect(result.crossings.map(({ commit: { subject }, outside }) => ({ subject, outside }))).toEqual([
      { subject: 'refactor: move s into rules', outside: ['packages/pyric/src/sandbox/s.ts'] },
      { subject: 'fix(rules): crosses into sandbox', outside: ['packages/pyric/src/sandbox/s.ts'] },
    ]);
  });

  test('runs from the command line and reads bare dates in UTC whatever the local timezone', () => {
    const script = resolve(import.meta.dir, 'rules-boundary-report.ts');
    const output = execFileSync(process.execPath, [script, '--ref=main', '--since=2026-10-01', '--until=2026-10-31'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, TZ: 'America/Los_Angeles' },
    });
    expect(output).toContain('Rules boundary report: main at ');
    expect(output).toContain('Window: 2026-10-01T00:00:00Z to 2026-10-31T23:59:59Z');
    expect(output).toContain('2 of 4 commits (50.0%) also touch paths outside the boundary.');
    expect(output).toContain('fix(rules): crosses into sandbox\n  packages/pyric/src/sandbox/s.ts\n');
  });

  test('defaults to the last 30 days and rejects a bad --days', () => {
    const reportWindow = resolveWindow(['--ref=main'], repo, new Date('2026-10-31T12:00:00Z'));
    expect({ since: reportWindow.since, until: reportWindow.until }).toEqual({ since: '2026-10-01T12:00:00Z', until: '2026-10-31T12:00:00Z' });
    expect(() => resolveWindow(['--ref=main', '--days=0'], repo)).toThrow('--days must be a positive whole number');
  });
});
