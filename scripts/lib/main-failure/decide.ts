// Decides what one completed attempt of a Build & Test push run on main
// needs: a rerun, flake issues, the main is red issue, the unconfirmed issue,
// closing the red and unconfirmed issues, or nothing. A pure function of the attempt, the
// attempt before it, and the open issues.

import type { Failure } from './parse-log.ts';
import {
  RED_PREFIX,
  UNCONFIRMED_PREFIX,
  closeBody,
  failureSubject,
  flakePrefix,
  flakeText,
  redText,
  namesPath,
  testFilePath,
  unconfirmedText,
} from './issue-text.ts';

/** A run whose log parses into more failures than this files only this many. */
export const MAX_FLAKE_ISSUES = 10;

export interface AttemptReport {
  runId: number;
  attempt: number;
  /** The run conclusion for this attempt: success, failure, cancelled, … */
  conclusion: string;
  headSha: string;
  url: string;
  failures: Failure[];
}

export interface OpenIssue {
  number: number;
  title: string;
  body?: string;
}

export interface DecisionInput {
  current: AttemptReport;
  /** The attempt before `current`, when `current` is attempt 2. */
  previous?: AttemptReport;
  openIssues: OpenIssue[];
  /** The commit is no longer the head of main, or a newer push run is
   *  pending, so a rerun would join (and cancel, or be cancelled by) it. */
  superseded?: boolean;
}

export interface IssueAction {
  kind: 'file-flake' | 'file-red' | 'file-unconfirmed';
  prefix: string;
  title: string;
  body: string;
  /** The open issue the filing comments on, or undefined when it opens one. */
  existing?: number;
}

export type Action =
  | { kind: 'rerun'; runId: number }
  | IssueAction
  | { kind: 'close'; prefix: string; number: number; body: string };

export interface Plan {
  reason: string;
  actions: Action[];
}

export const FAILED = new Set(['failure', 'timed_out']);

function issueWithPrefix(openIssues: OpenIssue[], prefix: string): number | undefined {
  return openIssues.find((issue) => issue.title.startsWith(prefix))?.number;
}

function isLaneStandingIssue(issue: OpenIssue): boolean {
  return issue.title.startsWith(RED_PREFIX) || issue.title.startsWith(UNCONFIRMED_PREFIX);
}

function mentions(issue: OpenIssue, path: string): boolean {
  return namesPath(issue.title, path) || namesPath(issue.body ?? '', path);
}

/** The open issue a flake belongs to: this lane's issue for the test, or else
 *  any other open issue that names the test file's repository path, such as
 *  one filed by hand or this lane's issue for another test in the same file.
 *  A failure with no test file matches only its own issue. */
function flakeIssue(openIssues: OpenIssue[], failure: Failure): number | undefined {
  const own = issueWithPrefix(openIssues, flakePrefix(failure));
  if (own !== undefined) return own;
  const path = testFilePath(failure);
  if (path === undefined) return undefined;
  return openIssues.find((issue) => !isLaneStandingIssue(issue) && mentions(issue, path))?.number;
}

function uniqueSubjects(failures: Failure[]): Failure[] {
  const seen = new Map<string, Failure>();
  for (const failure of failures) {
    if (!seen.has(failureSubject(failure))) seen.set(failureSubject(failure), failure);
  }
  return [...seen.values()];
}

function flakeAction(failure: Failure, failed: AttemptReport, passed: AttemptReport, openIssues: OpenIssue[]): IssueAction {
  return { kind: 'file-flake', ...flakeText(failure, failed, passed), existing: flakeIssue(openIssues, failure) };
}

function redAction(current: AttemptReport, previous: AttemptReport | undefined, openIssues: OpenIssue[]): IssueAction {
  return { kind: 'file-red', ...redText(current, previous), existing: issueWithPrefix(openIssues, RED_PREFIX) };
}

function unconfirmedAction(failed: AttemptReport, why: string, openIssues: OpenIssue[]): IssueAction {
  return { kind: 'file-unconfirmed', ...unconfirmedText(failed, why), existing: issueWithPrefix(openIssues, UNCONFIRMED_PREFIX) };
}

/** A green run closes the open red and unconfirmed issues. */
function closeStandingActions(current: AttemptReport, openIssues: OpenIssue[]): Action[] {
  return [RED_PREFIX, UNCONFIRMED_PREFIX].flatMap((prefix): Action[] => {
    const open = issueWithPrefix(openIssues, prefix);
    if (open === undefined) return [];
    return [{ kind: 'close', prefix, number: open, body: closeBody(current) }];
  });
}

const SUPERSEDED_REASON = 'a newer push to main superseded it before the rerun';
const RERUN_CANCELLED_REASON = 'the rerun of its failed jobs was cancelled';

function decideFailed(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  if (current.attempt >= 3) {
    return { reason: `attempt ${current.attempt} failed: past the one rerun, so nothing is rerun or filed`, actions: [] };
  }
  if (current.attempt === 2) {
    return { reason: 'attempt 2 failed again: main is red', actions: [redAction(current, previous, openIssues)] };
  }
  if (input.superseded === true) {
    return {
      reason: 'attempt 1 failed, but rerunning it would share the concurrency group with a newer push run: filed unconfirmed',
      actions: [unconfirmedAction(current, SUPERSEDED_REASON, openIssues)],
    };
  }
  return { reason: 'attempt 1 failed: rerun its failed jobs once', actions: [{ kind: 'rerun', runId: current.runId }] };
}

function decidePassed(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  const closing = closeStandingActions(current, openIssues);
  const rerunPassed = current.attempt === 2 && previous !== undefined && FAILED.has(previous.conclusion);
  if (!rerunPassed) return { reason: `attempt ${current.attempt} passed`, actions: closing };
  const flakes = uniqueSubjects(previous.failures).slice(0, MAX_FLAKE_ISSUES)
    .map((failure) => flakeAction(failure, previous, current, openIssues));
  return { reason: 'attempt 2 passed after attempt 1 failed: the failures were flakes', actions: [...flakes, ...closing] };
}

function decideUnfinished(input: DecisionInput): Plan {
  const { current, previous, openIssues } = input;
  const rerunCancelled = current.attempt === 2 && current.conclusion === 'cancelled'
    && previous !== undefined && FAILED.has(previous.conclusion);
  if (rerunCancelled) {
    return {
      reason: 'attempt 2 was cancelled after attempt 1 failed: filed unconfirmed',
      actions: [unconfirmedAction(previous, RERUN_CANCELLED_REASON, openIssues)],
    };
  }
  return { reason: `attempt ${current.attempt} ended ${current.conclusion}, so nothing is rerun or filed`, actions: [] };
}

/** What to do about one completed attempt of a push run on main. */
export function decide(input: DecisionInput): Plan {
  if (input.current.conclusion === 'success') return decidePassed(input);
  if (FAILED.has(input.current.conclusion)) return decideFailed(input);
  return decideUnfinished(input);
}
