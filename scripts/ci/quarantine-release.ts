#!/usr/bin/env bun
// After a Build & Test push run on main completes, comments on each
// quarantined test's tracking issue (scripts/lib/quarantine/release.ts): it
// failed in this run, it passed the last 20 main runs so its entry can go, or
// its quarantine expired. The runs' quarantine reports come from their
// `quarantine-report-<suite>-a<attempt>` artifacts. `.github/workflows/main-failure.yml`
// runs it:
//
//   RUN_ID=<run id> GITHUB_REPOSITORY=<owner/repo> [DRY_RUN=true] bun scripts/ci/quarantine-release.ts
//
// DRY_RUN=true prints the comments and posts nothing. Either way it refuses a
// run that is not a push run of Build & Test on main.

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnGh, type Gh } from './github-issues.ts';
import { REPO_ROOT, readEntries, todayUtc } from '../lib/quarantine/entries.ts';
import { RELEASE_STREAK, decideComments, type IssueComment, type RunReports } from '../lib/quarantine/release.ts';
import type { QuarantineReport } from '../lib/quarantine/report.ts';
import { honouredEntries } from '../lib/quarantine/validate.ts';

const ARTIFACT = /^quarantine-report-(.+)-a(\d+)$/;
const COUNTED = new Set(['success', 'failure']);

interface RunJson {
  id: number;
  conclusion: string | null;
  created_at: string;
  html_url: string;
  event?: string;
  head_branch?: string;
  path?: string;
}

/** Refuses anything but a push run of Build & Test on main, as the classify
 *  job does, so a dispatch cannot comment from a pull request's run. */
export function assertMainPushRun(run: RunJson): void {
  const isMainPush = run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/build.yml';
  if (!isMainPush) {
    throw new Error(`Run ${run.id} is a ${run.event} run of ${run.path} on ${run.head_branch}; only push runs of .github/workflows/build.yml on main are handled`);
  }
}

export interface ReleaseContext {
  gh: Gh;
  repo: string;
  workDir: string;
}

function api<T>(context: ReleaseContext, path: string): T {
  return JSON.parse(context.gh(['api', `repos/${context.repo}/${path}`])) as T;
}

/** The completed push runs on main that count, newest first, starting at `runId`. */
export function mainRuns(context: ReleaseContext, runId: number): RunJson[] {
  const current = api<RunJson>(context, `actions/runs/${runId}`);
  assertMainPushRun(current);
  const page = api<{ workflow_runs: RunJson[] }>(context, `actions/workflows/build.yml/runs?branch=main&event=push&status=completed&per_page=${RELEASE_STREAK + 20}`);
  const older = page.workflow_runs
    .filter((run) => run.id !== runId && run.created_at <= current.created_at && COUNTED.has(run.conclusion ?? ''))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [current, ...older];
}

/** The latest attempt's report of each suite in the downloaded artifacts. */
export function latestReports(dir: string): QuarantineReport[] {
  if (!existsSync(dir)) return [];
  const bySuite = new Map<string, { attempt: number; report: QuarantineReport }>();
  for (const name of readdirSync(dir)) {
    const match = ARTIFACT.exec(name);
    if (!match) continue;
    const attempt = Number(match[2]);
    const suite = match[1] ?? '';
    const files = readdirSync(join(dir, name)).filter((file) => file.endsWith('.json'));
    for (const file of files) {
      const report = JSON.parse(readFileSync(join(dir, name, file), 'utf8')) as QuarantineReport;
      const key = `${suite}/${report.suite}`;
      const kept = bySuite.get(key);
      if (kept === undefined || kept.attempt < attempt) bySuite.set(key, { attempt, report });
    }
  }
  return [...bySuite.values()].map((kept) => kept.report);
}

function download(context: ReleaseContext, runId: number): string {
  const dir = join(context.workDir, String(runId));
  try {
    context.gh(['run', 'download', String(runId), '--repo', context.repo, '--pattern', 'quarantine-report-*', '--dir', dir]);
  } catch (error) {
    console.warn(`run ${runId}: no quarantine reports (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
  return dir;
}

/** Each run's reports, downloaded the first time a decision asks for them. */
export function lazyHistory(context: ReleaseContext, runs: RunJson[]): (index: number) => RunReports | undefined {
  const cache = new Map<number, RunReports>();
  return (index) => {
    const run = runs[index];
    if (run === undefined) return undefined;
    const cached = cache.get(index);
    if (cached) return cached;
    const loaded = { runId: run.id, url: run.html_url, reports: latestReports(download(context, run.id)) };
    cache.set(index, loaded);
    return loaded;
  };
}

const MARKER = /<!-- quarantine:[^\n]*? -->/g;

export function postedMarkers(context: ReleaseContext, issues: number[]): Set<string> {
  const markers = new Set<string>();
  for (const issue of new Set(issues)) {
    const bodies = context.gh(['api', '--paginate', `repos/${context.repo}/issues/${issue}/comments?per_page=100`, '--jq', '.[].body']);
    for (const found of bodies.matchAll(MARKER)) markers.add(found[0]);
  }
  return markers;
}

function post(context: ReleaseContext, comment: IssueComment, index: number): void {
  const bodyFile = join(context.workDir, `comment-${index}.md`);
  writeFileSync(bodyFile, comment.body);
  console.log(context.gh(['issue', 'comment', String(comment.issue), '--repo', context.repo, '--body-file', bodyFile]).trim());
}

if (import.meta.main) {
  const runId = Number(process.env.RUN_ID);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!Number.isInteger(runId) || runId < 1 || !repo) {
    console.error('usage: RUN_ID=<run id> GITHUB_REPOSITORY=<owner/repo> [DRY_RUN=true] bun scripts/ci/quarantine-release.ts');
    process.exit(2);
  }
  const entries = honouredEntries(readEntries());
  if (entries.length === 0) {
    console.log('No quarantine entries: nothing to report.');
    process.exit(0);
  }
  const context: ReleaseContext = { gh: spawnGh(REPO_ROOT), repo, workDir: mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'quarantine-release-')) };
  const history = lazyHistory(context, mainRuns(context, runId));
  const posted = postedMarkers(context, entries.map((entry) => entry.issue));
  const comments = decideComments({ entries, today: todayUtc(), history, posted });
  if (comments.length === 0) console.log('No quarantine comments to post.');
  const dryRun = process.env.DRY_RUN !== 'false';
  comments.forEach((comment, index) => {
    if (dryRun) console.log(`Would comment on #${comment.issue}:\n${comment.body}`);
    else post(context, comment, index);
  });
}
