#!/usr/bin/env bun
/**
 * Fails a pull request that deletes tests or removes CI jobs unless its body
 * acknowledges it.
 *
 * A removed test cannot fail, so a pull request that deletes another change's
 * tests or CI job (for example through a rebase that reverts a merged change)
 * stays green. This guard lists, relative to the merge base:
 *   - deleted files under a test directory (`test/`, `tests/`, `__tests__/`,
 *     `fixtures/`) and deleted test files (`*.test.*`, `*.spec.*`, `*.pw.*`),
 *     including a rename that moves a test file out of those places;
 *   - jobs removed from `.github/workflows/*.yml`, including every job of a
 *     deleted workflow.
 * When the list is not empty, the pull request body must contain a line
 * `Removes tests: <reason>`.
 *
 * Usage: bun scripts/ci/deletion-guard.ts <base-sha> <head-sha>
 * The body is read from the file `PR_BODY_FILE` names, or else from the
 * `pull_request.body` of the event payload at `GITHUB_EVENT_PATH`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The acknowledgement a pull request body carries to remove tests or CI jobs. */
export const ACKNOWLEDGEMENT = /^Removes tests: *(?!<reason>)\S.*$/m;

/** One `git diff --name-status -z` record. */
export interface DiffEntry {
  status: string;
  path: string;
  previousPath?: string;
}

/** Parse the output of `git diff --name-status -z --find-renames`. */
export function parseNameStatus(output: string): DiffEntry[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const entries: DiffEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error('git diff emitted an empty status');
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) throw new Error(`git diff emitted an incomplete ${status} record`);
      entries.push({ status, path, previousPath });
      continue;
    }
    const path = fields[index++];
    if (!path) throw new Error(`git diff emitted an incomplete ${status} record`);
    entries.push({ status, path });
  }
  return entries;
}

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'fixtures']);
const TEST_FILE = /\.(test|spec|pw)\.[cm]?[jt]sx?$/;

/** Whether `path` is a test file or lives under a test directory. */
export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  const file = segments.pop() ?? '';
  return TEST_FILE.test(file) || segments.some((segment) => TEST_DIRECTORIES.has(segment));
}

/** The test files a diff deletes, or renames out of a test location. */
export function deletedTests(entries: readonly DiffEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.status.startsWith('D') && isTestPath(entry.path)) return [entry.path];
    if (entry.status.startsWith('R') && entry.previousPath && isTestPath(entry.previousPath) && !isTestPath(entry.path)) {
      return [`${entry.previousPath} (renamed to ${entry.path})`];
    }
    return [];
  });
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The workflow files a diff changes or deletes, by their path at the merge base. */
export function changedWorkflows(entries: readonly DiffEntry[]): string[] {
  return entries.flatMap((entry) => {
    const before = entry.previousPath ?? entry.path;
    return WORKFLOW.test(before) && !entry.status.startsWith('A') ? [before] : [];
  });
}

/** The job ids of a workflow file's source; none for an empty source. */
export function workflowJobs(source: string): string[] {
  if (source.trim() === '') return [];
  const parsed = Bun.YAML.parse(source) as { jobs?: Record<string, unknown> } | null;
  return Object.keys(parsed?.jobs ?? {});
}

/** The jobs present in `before` and absent from `after`, as `file: job`. */
export function removedJobs(path: string, before: string, after: string): string[] {
  const kept = new Set(workflowJobs(after));
  return workflowJobs(before)
    .filter((job) => !kept.has(job))
    .map((job) => `${path}: ${job}`);
}

/** What a pull request removes, and whether its body acknowledges it. */
export function verdict(input: { tests: string[]; jobs: string[]; body: string }): { ok: boolean; report: string } {
  const removes = input.tests.length + input.jobs.length > 0;
  const acknowledged = ACKNOWLEDGEMENT.test(input.body);
  const ok = !removes || acknowledged;
  const lines = [
    `## Test and CI job removals: ${ok ? 'PASS' : 'FAIL'}`,
    '',
    ...(removes
      ? [
        ...(input.tests.length ? ['Deleted test files:', ...input.tests.map((path) => `- ${path}`), ''] : []),
        ...(input.jobs.length ? ['Removed CI jobs:', ...input.jobs.map((job) => `- ${job}`), ''] : []),
        acknowledged
          ? `Acknowledged in the pull request body: "${input.body.match(ACKNOWLEDGEMENT)![0]}"`
          : 'The pull request body has no `Removes tests: <reason>` line. If these removals are intended, ' +
            'add that line to the body with the reason and re-run this job. If they are not, restore the ' +
            'files and jobs (a rebase that reverted merged changes is the usual cause).',
      ]
      : ['No test files deleted and no CI jobs removed.']),
    '',
  ];
  return { ok, report: lines.join('\n') };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** A file's content at `ref`, or the empty string when it does not exist there. */
function show(ref: string, path: string): string {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function pullRequestBody(): string {
  if (process.env.PR_BODY_FILE) return readFileSync(process.env.PR_BODY_FILE, 'utf8');
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('PR_BODY_FILE or GITHUB_EVENT_PATH is required');
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request?: { body?: string | null } };
  return event.pull_request?.body ?? '';
}

function main(): void {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!baseSha || !headSha) throw new Error('usage: deletion-guard.ts <base-sha> <head-sha>');
  const mergeBase = git(['merge-base', baseSha, headSha]).trim();
  const entries = parseNameStatus(git(['diff', '--name-status', '-z', '--find-renames', `${mergeBase}`, headSha]));
  const renamedTo = new Map(entries.filter((entry) => entry.previousPath).map((entry) => [entry.previousPath!, entry.path]));
  const jobs = changedWorkflows(entries).flatMap((path) =>
    removedJobs(path, show(mergeBase, path), show(headSha, renamedTo.get(path) ?? path)));
  const { ok, report } = verdict({ tests: deletedTests(entries), jobs, body: pullRequestBody() });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (!ok) process.exit(1);
}

if (import.meta.main) main();
