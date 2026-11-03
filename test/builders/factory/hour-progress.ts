/**
 * The hourly check's first line: what the run made this hour, before any
 * gate. Commits are counted in the harness's bare repo (`git.ts`), since
 * the start commit and since the commit the previous hour's check fetched;
 * items finished are the work list's ids now `ready` or `done` that the
 * previous hour's `result.json` didn't list. An hour whose check stopped
 * before it fetched is skipped for the one before it. For example:
 *
 *   hour 3: no commits this hour (9 since start, last at 19:08Z), 0 items finished this hour (8 ready, 0 done)
 *
 * The check puts it first in its summary, which feeds the journal,
 * `result.json`, `latest-check.json` and the timeline.
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { AppPaths } from './app-paths.ts';
import { bareGit } from './git.ts';
import { optional } from './optional.ts';
import { runPaths } from './run-dir.ts';
import type { CheckProgress } from './session.ts';
import { readJson } from './state-files.ts';
import { readWorkList } from './work-list.ts';

/** What this hour's progress needs from the previous hour's `result.json`. */
const previousSchema = z.object({
  commit: z.string().optional(),
  progress: z.object({ readyOrDone: z.array(z.string()) }).passthrough().optional(),
}).passthrough();

type Previous = z.infer<typeof previousSchema>;

export interface ProgressInput {
  paths: AppPaths;
  hour: number;
  startCommit: string;
  /** The commit this hour's check fetched. */
  commit: string;
}

function readResult(paths: AppPaths, hour: number): Previous {
  try {
    return readJson(join(paths.checks, `hour-${hour}`, 'result.json'), previousSchema) ?? {};
  } catch {
    return {};
  }
}

/**
 * The newest earlier hour's commit and ready-or-done list, read through the
 * `hour-<n>` links: an hour whose check stopped before it fetched is
 * skipped, so its items are not counted again. Empty for the first hour.
 */
function previousResult(paths: AppPaths, hour: number): Previous {
  let found: Previous = {};
  for (let earlier = hour - 1; earlier >= 1; earlier -= 1) {
    const result = readResult(paths, earlier);
    found = { commit: found.commit ?? result.commit, progress: found.progress ?? result.progress };
    const hasBoth = found.commit !== undefined && found.progress !== undefined;
    if (hasBoth) break;
  }
  return found;
}

function isCommit(gitDir: string, ref: string): boolean {
  try {
    bareGit(gitDir, ['rev-parse', '--quiet', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The commit the previous hour fetched, when the bare repo still has it. */
function previousCommit(gitDir: string, previous: Previous): string | undefined {
  const commit = previous.commit;
  const isKnown = commit !== undefined && isCommit(gitDir, commit);
  return isKnown ? commit : undefined;
}

function countCommits(gitDir: string, from: string, to: string): number {
  return Number(bareGit(gitDir, ['rev-list', '--count', `${from}..${to}`]).trim());
}

/** The commit time of `commit` when it is newer than the start, as an ISO time; undefined when there is none. */
function lastCommitAt(gitDir: string, commit: string, since: number): string | undefined {
  if (since === 0) return undefined;
  const seconds = Number(bareGit(gitDir, ['log', '-1', '--format=%ct', commit]).trim());
  return new Date(seconds * 1000).toISOString();
}

interface Items {
  readyOrDone: string[];
  ready: number;
  done: number;
}

function workItems(runDir: string): Items | undefined {
  const read = readWorkList(runPaths(runDir).files.workList);
  if (!read.ok) return undefined;
  const ready = read.items.filter((item) => item.status === 'ready');
  const done = read.items.filter((item) => item.status === 'done');
  return { readyOrDone: [...ready, ...done].map((item) => item.id), ready: ready.length, done: done.length };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `19:08Z` from an ISO time. */
const clock = (iso: string): string => `${iso.slice(11, 16)}Z`;

function commitsPart(progress: Omit<CheckProgress, 'line'>): string {
  const thisHour = progress.commitsThisHour === 0 ? 'no commits' : plural(progress.commitsThisHour, 'commit');
  const last = progress.lastCommitAt === undefined ? '' : `, last at ${clock(progress.lastCommitAt)}`;
  const since = progress.commitsSinceStart === 0 ? 'none since start' : `${progress.commitsSinceStart} since start${last}`;
  return `${thisHour} this hour (${since})`;
}

function itemsPart(progress: Omit<CheckProgress, 'line'>): string {
  const isUnreadable = progress.ready === undefined || progress.done === undefined;
  if (isUnreadable) return 'items finished unknown: the work list does not parse';
  const named = progress.finished.length === 0 ? '' : `: ${progress.finished.join(', ')}`;
  return `${plural(progress.finished.length, 'item')} finished this hour${named} (${progress.ready} ready, ${progress.done} done)`;
}

/** The progress line, from its counts. */
export function progressLine(hour: number, progress: Omit<CheckProgress, 'line'>): string {
  return `hour ${hour}: ${commitsPart(progress)}, ${itemsPart(progress)}`;
}

/** This hour's commits and finished items, after the check has fetched `commit`. */
export function hourProgress(input: ProgressInput): CheckProgress {
  const { paths, hour, startCommit, commit } = input;
  const previous = previousResult(paths, hour);
  const hourStart = previousCommit(paths.gitDir, previous) ?? startCommit;
  const commitsSinceStart = countCommits(paths.gitDir, startCommit, commit);
  const items = workItems(paths.runDir);
  const seen = new Set(previous.progress?.readyOrDone ?? []);
  const counts: Omit<CheckProgress, 'line'> = {
    commitsThisHour: countCommits(paths.gitDir, hourStart, commit),
    commitsSinceStart,
    ...optional('lastCommitAt', lastCommitAt(paths.gitDir, commit, commitsSinceStart)),
    finished: (items?.readyOrDone ?? []).filter((id) => !seen.has(id)),
    readyOrDone: items?.readyOrDone ?? [...seen],
    ...(items === undefined ? {} : { ready: items.ready, done: items.done }),
  };
  return { line: progressLine(hour, counts), ...counts };
}
