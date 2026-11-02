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
  /** The work list, progress notes and latest check every session reads. */
  files: StateFiles;
  /** The run's end, as an ISO time. */
  deadline: string;
  /** Milliseconds from the session's start to the deadline. */
  remainingMs: number;
  /** Aborted at the deadline, or when the supervisor stops. The runner kills the session then. */
  signal: AbortSignal;
}

export type RunSession = (role: Role, options: SessionOptions) => Promise<SessionResult>;

/** What an hourly check reports. The check itself comes in a later pull request. */
export interface CheckResult {
  passed: boolean;
  summary: string;
}

export interface CheckContext {
  runDir: string;
  appDir: string;
  /** Whole hours since the run started: 1 for the first check. */
  hour: number;
  signal: AbortSignal;
}

export type HourlyCheck = (context: CheckContext) => Promise<CheckResult>;

/** The hook until the hourly check lands: it checks nothing, and still wakes the on-demand roles. */
export const noHourlyCheck: HourlyCheck = async () => ({ passed: true, summary: 'no hourly check is wired yet' });
