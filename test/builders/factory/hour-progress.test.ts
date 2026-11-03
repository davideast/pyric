// The hourly check's progress line: commits this hour and since the start,
// counted in a temporary bare repo; items finished against the previous
// hour's list, skipping an hour whose check stopped before it fetched; the
// zero case's wording; the check's summary and result leading with it, also
// when a later step throws; and factory-summary's first line.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPaths, type AppPaths } from './app-paths.ts';
import { freshCheckDir, publishCheck, writeResult } from './check-output.ts';
import { bareGit, initBareRepo } from './git.ts';
import { hourProgress, progressLine } from './hour-progress.ts';
import { runHourlyCheck } from './hourly-check.ts';
import { formatSummary } from './summary.ts';
import type { TimelineLine } from './timeline.ts';
import type { WorkItem } from './work-list.ts';

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

interface Repo {
  paths: AppPaths;
  source: string;
  /** Commits on the roles' clone, made at `at` (seconds since the epoch), fetched into the bare repo; returns the new HEAD. */
  commit: (count: number, at?: number) => string;
}

function repo(): Repo {
  const runDir = join(mkdtempSync(join(tmpdir(), 'factory-progress-')), 'run');
  const source = join(runDir, 'app');
  mkdirSync(source, { recursive: true });
  const paths = appPaths(runDir);
  mkdirSync(paths.host, { recursive: true, mode: 0o700 });
  initBareRepo(paths.gitDir);
  sh(source, ['init', '--quiet']);
  const commit = (count: number, at = 1_700_000_000): string => {
    const date = `${at} +0000`;
    for (let made = 0; made < count; made += 1) sh(source, ['commit', '--quiet', '--allow-empty', '-m', `c${made}`], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
    bareGit(paths.gitDir, ['fetch', '--quiet', source, '+HEAD:refs/factory/head']);
    return sh(source, ['rev-parse', 'HEAD']);
  };
  return { paths, source, commit };
}

function writeWorkList(paths: AppPaths, items: WorkItem[]): void {
  writeFileSync(join(paths.runDir, 'work-list.json'), JSON.stringify({ items }));
}

const item = (id: string, status: WorkItem['status']): WorkItem => ({ id, title: id, status });

/** A finished check's `result.json` for `hour`, as the check writes it. */
function recordHour(paths: AppPaths, hour: number, fields: { commit?: string; readyOrDone?: string[] }): void {
  const dir = freshCheckDir(paths, `hour-${hour}`);
  const progress = fields.readyOrDone === undefined ? {} : { progress: { line: '', commitsThisHour: 0, commitsSinceStart: 0, finished: [], readyOrDone: fields.readyOrDone } };
  writeResult(dir, { hour, at: new Date().toISOString(), passed: false, summary: '', gates: [], ...(fields.commit === undefined ? {} : { commit: fields.commit }), ...progress });
  publishCheck(paths, hour, dir);
}

describe('commits', () => {
  test('counts this hour from the previous hour\'s commit and since the start, with the last commit\'s time', () => {
    const { paths, commit } = repo();
    const start = commit(1);
    const previous = commit(3);
    recordHour(paths, 1, { commit: previous, readyOrDone: [] });
    const head = commit(2, Date.parse('2026-11-02T19:08:11Z') / 1000);
    const progress = hourProgress({ paths, hour: 2, startCommit: start, commit: head });
    expect(progress.commitsThisHour).toBe(2);
    expect(progress.commitsSinceStart).toBe(5);
    expect(progress.lastCommitAt).toBe('2026-11-02T19:08:11.000Z');
    expect(progress.line).toStartWith('hour 2: 2 commits this hour (5 since start, last at 19:08Z)');
  });

  test('the first hour counts from the start commit', () => {
    const { paths, commit } = repo();
    const start = commit(1);
    const head = commit(1);
    const progress = hourProgress({ paths, hour: 1, startCommit: start, commit: head });
    expect(progress.commitsThisHour).toBe(1);
    expect(progress.line).toStartWith('hour 1: 1 commit this hour (1 since start, last at ');
  });
});

describe('items finished', () => {
  test('counts ids now ready or done that the previous hour didn\'t list', () => {
    const { paths, commit } = repo();
    const start = commit(1);
    recordHour(paths, 1, { commit: start, readyOrDone: ['a'] });
    writeWorkList(paths, [item('a', 'done'), item('b', 'ready'), item('c', 'in-progress')]);
    const progress = hourProgress({ paths, hour: 2, startCommit: start, commit: start });
    expect(progress.finished).toEqual(['b']);
    expect(progress.readyOrDone).toEqual(['b', 'a']);
    expect(progress.line).toEndWith('1 item finished this hour: b (1 ready, 1 done)');
  });

  test('an hour whose check stopped before it fetched is skipped for the one before it', () => {
    const { paths, commit } = repo();
    const start = commit(1);
    const first = commit(2);
    recordHour(paths, 1, { commit: first, readyOrDone: ['a'] });
    recordHour(paths, 2, {});
    writeWorkList(paths, [item('a', 'ready')]);
    const head = commit(1);
    const progress = hourProgress({ paths, hour: 3, startCommit: start, commit: head });
    expect(progress.finished).toEqual([]);
    expect(progress.commitsThisHour).toBe(1);
  });

  test('a work list that does not parse is named, and keeps the earlier list for the next hour', () => {
    const { paths, commit } = repo();
    const start = commit(1);
    recordHour(paths, 1, { commit: start, readyOrDone: ['a'] });
    writeFileSync(join(paths.runDir, 'work-list.json'), '{"items": [');
    const progress = hourProgress({ paths, hour: 2, startCommit: start, commit: start });
    expect(progress.readyOrDone).toEqual(['a']);
    expect(progress.line).toEndWith('items finished unknown: the work list does not parse');
  });
});

describe('the zero case', () => {
  test('says no commits this hour and 0 items finished', () => {
    const line = progressLine(3, { commitsThisHour: 0, commitsSinceStart: 9, lastCommitAt: '2026-11-02T19:08:11.000Z', finished: [], readyOrDone: [], ready: 8, done: 0 });
    expect(line).toBe('hour 3: no commits this hour (9 since start, last at 19:08Z), 0 items finished this hour (8 ready, 0 done)');
    const none = progressLine(1, { commitsThisHour: 0, commitsSinceStart: 0, finished: [], readyOrDone: [], ready: 0, done: 0 });
    expect(none).toBe('hour 1: no commits this hour (none since start), 0 items finished this hour (0 ready, 0 done)');
  });
});

describe('the check\'s summary', () => {
  test('starts with the progress line when a later step throws, and result.json carries it', async () => {
    const { paths, commit } = repo();
    const start = commit(1);
    commit(2);
    writeWorkList(paths, [item('a', 'ready')]);
    const briefDir = join(paths.runDir, 'brief');
    mkdirSync(join(briefDir, 'walks'), { recursive: true });
    writeFileSync(join(briefDir, 'walks', 'home.mjs'), '');
    const record = { source: '/src', sourceCommit: start, startCommit: start, setupAt: new Date().toISOString(), briefDir, adaptations: [], tools: {} };
    writeFileSync(paths.record, JSON.stringify(record));
    const said: string[] = [];
    const openSandbox = () => {
      throw new Error('no sandbox in this test');
    };
    const context = { runDir: paths.runDir, appDir: join(paths.runDir, 'app'), hour: 1, signal: new AbortController().signal };
    const result = await runHourlyCheck(context, { say: (line) => said.push(line), openSandbox });
    const line = 'hour 1: 2 commits this hour (2 since start, last at ';
    expect(result.summary).toStartWith(line);
    expect(result.summary).toContain('1 item finished this hour: a (1 ready, 0 done). the check failed: ');
    expect(result.progress?.commitsSinceStart).toBe(2);
    expect(said.some((text) => text.startsWith(line))).toBe(true);
    const written = JSON.parse(readFileSync(join(result.resultDir, 'result.json'), 'utf8')) as { summary: string; progress?: { readyOrDone: string[] } };
    expect(written.summary).toStartWith(line);
    expect(written.progress?.readyOrDone).toEqual(['a']);
  });
});

describe('factory-summary', () => {
  const progress = { line: '', commitsThisHour: 0, commitsSinceStart: 9, finished: [], readyOrDone: ['a', 'b'], ready: 2, done: 0 };
  const check = (hour: number, withProgress: boolean): TimelineLine => ({ type: 'check', at: '2026-11-02T19:24:00.000Z', hour, passed: false, summary: 's', ...(withProgress ? { progress } : {}) });

  test('the first line adds the commits and finished items of the newest check that counted them', () => {
    const first = formatSummary([check(1, true), check(2, false)]).split('\n')[0] ?? '';
    expect(first).toStartWith('9 commits and 2 items finished since start; 0 sessions');
  });

  test('a run with no counted check says so', () => {
    expect(formatSummary([]).split('\n')[0]).toStartWith('no commits or finished items counted yet; 0 sessions');
  });
});
