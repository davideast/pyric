/**
 * The seam between the supervisor and the session runner. The supervisor
 * decides which role works next and for how long; the runner starts one
 * agent session for it and says how the session ended. Tests pass a fake.
 */
import type { StateFiles } from './run-dir.ts';

export type Role = 'lead' | 'builder' | 'user-agent' | 'design-reviewer' | 'triage';

/** Why a session ended. `deadline` is the supervisor stopping it at the run's end. */
export type EndedBy = 'exit' | 'rate-limit' | 'killed' | 'deadline';

export interface SessionResult {
  exitCode: number;
  endedBy: EndedBy;
  /** When the rate limit lifts, as an ISO time, when the session said. */
  resetAt?: string;
  logPath: string;
}

export interface SessionOptions {
  /** Which of the role's seats this is: `builder-1` and `builder-2` share the role `builder`. */
  seat: string;
  /** What this session is asked to do. */
  prompt: string;
  runDir: string;
  /** The app repo every role works in. */
  appDir: string;
  /** The agent adapter the run uses, by name (`agents/registry.ts`). */
  agent: string;
  /** The brief, specs and design every role reads: outside the run directory, read-only in the sandbox. */
  briefDir: string;
  /** The work list, progress notes and latest check every session reads. */
  files: StateFiles;
  /** The run's end, as an ISO time. */
  deadline: string;
  /** Milliseconds from the session's start to the deadline. */
  remainingMs: number;
  /** Aborted at the deadline, or when the supervisor stops. The runner kills the session then. */
  signal: AbortSignal;
  /** The sessions' provider socket, bound read-only into the sandbox, when the run has `--provider-keys`. */
  providerSocket?: string;
}

export type RunSession = (role: Role, options: SessionOptions) => Promise<SessionResult>;

/** What the run made by an hourly check (`hour-progress.ts`). */
export interface CheckProgress {
  /** The line the check's summary starts with. */
  line: string;
  /** Commits since the commit the previous hour's check fetched, or since the start commit. */
  commitsThisHour: number;
  commitsSinceStart: number;
  /** The checked commit's time, as an ISO time, when it is newer than the start commit. */
  lastCommitAt?: string;
  /** Ids now `ready` or `done` that the previous hour's check didn't list. */
  finished: string[];
  /** Every id now `ready` or `done`, which the next hour's check compares against. */
  readyOrDone: string[];
  /** How many items are `ready` and `done`; absent when the work list doesn't parse. */
  ready?: number;
  done?: number;
}

/** What an hourly check reports (`hourly-check.ts`). */
export interface CheckResult {
  passed: boolean;
  summary: string;
  /** What the run made, when the check got as far as fetching the commit. */
  progress?: CheckProgress;
}

export interface CheckContext {
  runDir: string;
  appDir: string;
  /** Whole hours since the run started: 1 for the first check. */
  hour: number;
  signal: AbortSignal;
  /** The served copy's provider socket, when the run has `--provider-keys`. The check's own sandbox never gets one. */
  providerSocket?: string;
}

export type HourlyCheck = (context: CheckContext) => Promise<CheckResult>;

/** Runs once when the run ends, after every session has stopped: the served copy's teardown. */
export type RunEnd = (runDir: string) => Promise<void>;

/** The hook until the hourly check lands: it checks nothing, and still wakes the on-demand roles. */
export const noHourlyCheck: HourlyCheck = async () => ({ passed: true, summary: 'no hourly check is wired yet' });
