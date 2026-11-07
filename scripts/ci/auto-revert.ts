// Decides whether a failed push run on main gets its merge reverted. Pure:
// `auto-revert-github.ts` gathers the facts and carries out the verdict, and
// `.github/workflows/auto-revert.yml` runs it.
//
// A run is reverted only in its second attempt, after a rerun of its failed
// jobs failed again, and only when its head commit is the culprit: the run of
// the same workflow on the commit's first parent passed. A red parent means
// main was already red, and a parent with no finished run leaves the culprit
// unknown; neither is reverted. Nor is a revert, nor a run whose failures
// include a quarantined test.

import { SEPARATOR, UNNAMED, isActive, type Entry } from '../lib/quarantine/entries.ts';

/** The workflows whose failures on main are reverted, and which lane reruns
 *  the failed jobs. The main failure lane already reruns Build & Test once, so
 *  a rerun here would start a third attempt. */
export const WATCHED: Readonly<Record<string, { rerunBy: 'main-failure' | 'auto-revert' }>> = {
  'Build & Test': { rerunBy: 'main-failure' },
  'Slow app scenarios': { rerunBy: 'auto-revert' },
};

/** A branch this lane pushes a revert to, one per reverted commit. */
export const BRANCH_PREFIX = 'auto-revert/';

/** One failing test, or a failing job whose log names no test. */
export interface RunFailure {
  job: string;
  /** `<repo path> > <test>`, as the quarantine names it. */
  test?: string;
}

export interface FailedRun {
  workflow: string;
  runId: number;
  attempt: number;
  url: string;
  headSha: string;
  /** The head commit's parents; a merge has two. */
  parents: string[];
  /** The head commit's full message. */
  message: string;
  /** The pull request the head commit merged, if any. */
  pull?: { number: number; title: string; headRef: string };
  failures: RunFailure[];
}

export interface Facts {
  run: FailedRun;
  /** The latest conclusion of the same workflow's push run on the first
   *  parent: undefined when there is none or it has not finished. */
  parentConclusion?: string;
  /** Whether main moved past the run, or a newer push run is pending, so a
   *  rerun would join a newer run's concurrency group. */
  superseded: boolean;
  /** A revert pull request for this commit in any state. One a person closed
   *  is never opened again. */
  existingRevert?: { number: number; state: string };
  quarantine: Pick<Entry, 'test' | 'expires'>[];
  today: string;
}

export type Verdict =
  | { kind: 'skip'; reason: string }
  | { kind: 'rerun' }
  | { kind: 'revert'; title: string; branch: string; mainline: boolean };

const FAILED = new Set(['failure', 'timed_out']);

/** Whether the commit is a revert: a revert pull request merged, a commit git
 *  revert wrote, or a merge of this lane's own branch. */
export function isRevert(run: FailedRun): boolean {
  const title = run.pull?.title ?? '';
  const revertTitle = /^revert[:(\s"]/i.test(title);
  const revertSubject = /^revert[:(\s"]/i.test(run.message);
  const revertBody = /^This reverts commit [0-9a-f]{7,40}/m.test(run.message);
  const ownBranch = (run.pull?.headRef ?? '').startsWith(BRANCH_PREFIX);
  return revertTitle || revertSubject || revertBody || ownBranch;
}

function covers(entry: Pick<Entry, 'test'>, test: string): boolean {
  if (entry.test === test) return true;
  const unnamedScope = entry.test.endsWith(`${SEPARATOR}${UNNAMED}`) ? entry.test.slice(0, -UNNAMED.length) : undefined;
  const appEntry = /^test\/apps\/[^/]+$/.test(entry.test) ? `${entry.test}/` : undefined;
  const prefix = unnamedScope ?? appEntry;
  return prefix !== undefined && test.startsWith(prefix);
}

/** The failing tests an active quarantine entry covers. */
export function quarantinedFailures(failures: RunFailure[], entries: Facts['quarantine'], today: string): string[] {
  const active = entries.filter((entry) => isActive(entry, today));
  return failures
    .map((failure) => failure.test)
    .filter((test): test is string => test !== undefined)
    .filter((test) => active.some((entry) => covers(entry, test)));
}

/** The title of the commit's change: its pull request's, or its subject. */
export function originalTitle(run: FailedRun): string {
  return run.pull?.title ?? run.message.split('\n')[0] ?? run.headSha;
}

function culpritProblem(facts: Facts): string | undefined {
  const { run, parentConclusion } = facts;
  if (isRevert(run)) return `${run.headSha} is a revert; reverting it again is left to a person`;
  if (parentConclusion === undefined) return `no finished ${run.workflow} push run on the parent ${run.parents[0] ?? '(none)'}, so the culprit is unknown`;
  if (FAILED.has(parentConclusion)) return `the run on the parent ${run.parents[0]} failed too, so main was already red`;
  if (parentConclusion !== 'success') return `the run on the parent ${run.parents[0]} ended ${parentConclusion}, so the culprit is unknown`;
  const quarantined = quarantinedFailures(run.failures, facts.quarantine, facts.today);
  if (quarantined.length > 0) return `quarantined tests failed: ${quarantined.join(', ')}`;
  return undefined;
}

function firstAttempt(facts: Facts): Verdict {
  const watched = WATCHED[facts.run.workflow];
  if (watched?.rerunBy === 'main-failure') return { kind: 'skip', reason: 'the main failure lane reruns this run; the revert waits for attempt 2' };
  if (facts.superseded) return { kind: 'skip', reason: 'main moved on or a newer run is pending, so a rerun would cancel it' };
  return { kind: 'rerun' };
}

function secondAttempt(facts: Facts): Verdict {
  const { run } = facts;
  const existing = facts.existingRevert;
  if (existing !== undefined) return { kind: 'skip', reason: `revert pull request #${existing.number} already exists (${existing.state.toLowerCase()})` };
  return {
    kind: 'revert',
    title: `revert: ${originalTitle(run)}`,
    branch: `${BRANCH_PREFIX}${run.headSha}`,
    mainline: run.parents.length > 1,
  };
}

export function decide(facts: Facts): Verdict {
  const { run } = facts;
  if (WATCHED[run.workflow] === undefined) return { kind: 'skip', reason: `${run.workflow} is not watched` };
  if (run.attempt > 2) return { kind: 'skip', reason: `attempt ${run.attempt} is past the one rerun` };
  const problem = culpritProblem(facts);
  if (problem !== undefined) return { kind: 'skip', reason: problem };
  if (run.attempt === 1) return firstAttempt(facts);
  return secondAttempt(facts);
}

/** The git commands that make the revert commit on a branch from main. */
export function revertCommands(run: FailedRun, verdict: Extract<Verdict, { kind: 'revert' }>): [string[], string[]] {
  const revert = verdict.mainline ? ['revert', '--no-edit', '-m', '1', run.headSha] : ['revert', '--no-edit', run.headSha];
  return [['switch', '-c', verdict.branch, 'origin/main'], revert];
}

export interface RevertEvidence {
  run: FailedRun;
  failedJobs: string[];
  parentRunUrl?: string;
}

export function revertBody({ run, failedJobs, parentRunUrl }: RevertEvidence): string {
  const subject = run.pull === undefined ? `commit ${run.headSha}` : `#${run.pull.number} (${run.headSha})`;
  const jobs = failedJobs.length > 0 ? failedJobs.map((job) => `\`${job}\``).join(', ') : 'none named';
  const tests = run.failures.map((failure) => failure.test).filter((test) => test !== undefined);
  const lines = [
    `Reverts ${subject}: ${run.workflow} on main failed on that commit and failed again on a rerun of its failed jobs.`,
    '',
    `- Failing run: ${run.url} (attempt ${run.attempt})`,
    `- Failing jobs: ${jobs}`,
  ];
  if (tests.length > 0) lines.push(`- Failing tests: ${tests.map((test) => `\`${test}\``).join(', ')}`);
  if (parentRunUrl !== undefined) lines.push(`- Passed on the parent commit: ${parentRunUrl}`);
  lines.push(
    '',
    'The auto-revert workflow opened this pull request and enabled auto-merge.',
    'To keep the change instead, fix main forward and close this pull request.',
  );
  return `${lines.join('\n')}\n`;
}
