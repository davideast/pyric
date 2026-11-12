#!/usr/bin/env bun
/**
 * Rules boundary report (#1521, section 8).
 *
 * The measure for moving @pyric/rules to its own repo: over a rolling window,
 * how many commits on main that change the engine's source also change paths
 * outside the boundary. The test is fewer than 1 in 5.
 *
 * It counts commits, not merges, because a batch merge folds many PRs into
 * one. A rename counts both its old and new path, so a file moved across the
 * boundary crosses it. Every crossing commit is listed with the paths that
 * crossed. Run it by hand once a week and post the output to #1521.
 *
 * The engine is packages/rules/src, and the boundary is the whole
 * packages/rules package plus the rules conformance data, which moves with
 * the repo. The tests left in packages/pyric/test/rules test the engine
 * through pyric, so they sit outside: a commit that changes them with the
 * engine crosses.
 *
 * Engine commits from before the package existed changed
 * packages/pyric/src/rules, which this report no longer reads, so a window
 * that starts before the move (#1521 PR 12) undercounts them.
 *
 * Usage: bun scripts/rules-boundary-report.ts [--ref=origin/main] [--days=30]
 *        bun scripts/rules-boundary-report.ts --since=2026-09-28 --until=2026-10-28
 *
 * --days is ignored when --since is given. The window filters on committer
 * date, and a bare YYYY-MM-DD covers that whole day in UTC.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const ENGINE_SOURCE = 'packages/rules/src';

/** Path prefixes inside the boundary, and the conformance data patterns that move with it. */
const BOUNDARY: readonly RegExp[] = [
  /^packages\/rules\//,
  /^packages\/conformance\/rules-corpus\//,
  /^packages\/conformance\/rules-language\//,
  /^packages\/conformance\/observations\/[^/]+-rules\//,
  /^packages\/conformance\/registry\/rules\.ts$/,
  /^packages\/conformance\/assurance-node-counts\/(rules|[^/]+-rules)\//,
];

/** The share of crossing commits the split test allows, exclusive. */
const SPLIT_THRESHOLD = 0.2;

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  paths: string[];
}

interface Crossing {
  commit: Commit;
  outside: string[];
}

interface Measure {
  total: number;
  crossings: Crossing[];
}

interface ReportWindow {
  ref: string;
  head: string;
  since: string;
  until: string;
}

const RECORD = '\x1e';
const FIELD = '\x1f';
const LOG_FORMAT = `${RECORD}%H${FIELD}%cs${FIELD}%s`;

/** Git separates a record's header from its first path with a newline. */
function withoutLeadingNewline(path: string): string {
  return path.startsWith('\n') ? path.slice(1) : path;
}

/** Reads `git log --name-only -z` output written with LOG_FORMAT. */
export function parseLog(output: string): Commit[] {
  return output
    .split(RECORD)
    .filter((record) => record.length > 0)
    .map((record) => {
      const [header = '', ...paths] = record.split('\0');
      const [hash, date, subject] = header.split(FIELD);
      const isComplete = hash !== undefined && date !== undefined && subject !== undefined;
      if (!isComplete) throw new Error(`incomplete log record: ${JSON.stringify(header)}`);
      return { hash, date, subject, paths: paths.map(withoutLeadingNewline).filter((path) => path.length > 0) };
    });
}

export function isInsideBoundary(path: string): boolean {
  return BOUNDARY.some((pattern) => pattern.test(path));
}

export function measure(commits: readonly Commit[]): Measure {
  const crossings = commits
    .map((commit) => ({ commit, outside: commit.paths.filter((path) => !isInsideBoundary(path)) }))
    .filter((crossing) => crossing.outside.length > 0);
  return { total: commits.length, crossings };
}

/** The share to one decimal place, so a figure just under 20% does not print as 20%. */
function percent(part: number, whole: number): string {
  if (whole === 0) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function verdict({ total, crossings }: Measure): string {
  const meetsTest = total > 0 && crossings.length / total < SPLIT_THRESHOLD;
  return meetsTest ? 'meets the split test' : 'does not meet the split test';
}

export function formatReport(result: Measure, reportWindow: ReportWindow): string {
  const lines = [
    `Rules boundary report: ${reportWindow.ref} at ${reportWindow.head.slice(0, 9)}`,
    `Window: ${reportWindow.since} to ${reportWindow.until}, commits (not merges) that touch ${ENGINE_SOURCE}`,
    `Boundary: ${BOUNDARY.map((pattern) => pattern.source).join(', ')}`,
    '',
    `${result.crossings.length} of ${result.total} commits (${percent(result.crossings.length, result.total)}) also touch paths outside the boundary.`,
    `The test is fewer than 1 in 5: this window ${verdict(result)}.`,
  ];
  for (const { commit, outside } of result.crossings) {
    lines.push('', `${commit.hash.slice(0, 9)} ${commit.date} ${commit.subject}`);
    for (const path of outside) lines.push(`  ${path}`);
  }
  return `${lines.join('\n')}\n`;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Non-merge commits reachable from `reportWindow.ref` in the window that touch ENGINE_SOURCE, with all their paths. */
export function readCommits(reportWindow: ReportWindow, cwd: string): Commit[] {
  return parseLog(git([
    'log', reportWindow.head, '--no-merges', '--no-renames', '--full-diff', '--name-only', '-z',
    `--since=${reportWindow.since}`, `--until=${reportWindow.until}`, `--format=${LOG_FORMAT}`,
    '--', ENGINE_SOURCE,
  ], cwd));
}

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare `YYYY-MM-DD` covers the whole day in UTC. Git would otherwise fill
 * in the current time of day, and read the date in the local timezone.
 */
function wholeDay(value: string, time: string): string {
  return BARE_DAY.test(value) ? `${value}T${time}Z` : value;
}

function toSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function resolveWindow(argv: readonly string[], cwd: string, now: Date = new Date()): ReportWindow {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ref: { type: 'string', default: 'origin/main' },
      days: { type: 'string', default: '30' },
      since: { type: 'string' },
      until: { type: 'string' },
    },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive whole number, received "${values.days}"`);
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const ref = values.ref;
  return {
    ref,
    head: git(['rev-parse', '--verify', `${ref}^{commit}`], cwd).trim(),
    since: wholeDay(values.since ?? toSecond(start), '00:00:00'),
    until: wholeDay(values.until ?? toSecond(now), '23:59:59'),
  };
}

if (import.meta.main) {
  const cwd = process.cwd();
  const reportWindow = resolveWindow(process.argv.slice(2), cwd);
  process.stdout.write(formatReport(measure(readCommits(reportWindow, cwd)), reportWindow));
}
