/**
 * A `RunSession` for tests: each session lasts as long as `plan` says, on the
 * fake clock, and ends as `plan` says, or `killed` when its signal aborts. It
 * keeps every call and the most sessions it saw at once.
 */
import type { FakeClock } from './fake-clock.ts';
import type { Role, RunSession, SessionOptions, SessionResult } from './session.ts';

export interface PlannedSession {
  ms: number;
  result?: Partial<SessionResult>;
  /** Runs when the session starts, as the session's own work would: writing the work list, say. */
  onStart?: () => void;
}

export interface SessionCall {
  role: Role;
  seat: string;
  prompt: string;
  start: number;
  remainingMs: number;
  /** Set when the session ends. */
  end?: number;
  aborted?: boolean;
}

export interface FakeSessions {
  runSession: RunSession;
  calls: SessionCall[];
  maxAtOnce(): number;
}

export type SessionPlan = (role: Role, options: SessionOptions, call: number) => PlannedSession;

export function fakeSessions(clock: FakeClock, plan: SessionPlan): FakeSessions {
  const calls: SessionCall[] = [];
  let active = 0;
  let most = 0;
  const runSession: RunSession = async (role, options) => {
    const call: SessionCall = { role, seat: options.seat, prompt: options.prompt, start: clock.now(), remainingMs: options.remainingMs };
    const planned = plan(role, options, calls.filter((earlier) => earlier.seat === options.seat).length);
    calls.push(call);
    active += 1;
    most = Math.max(most, active);
    planned.onStart?.();
    await clock.sleep(planned.ms, options.signal);
    active -= 1;
    call.end = clock.now();
    call.aborted = options.signal.aborted;
    const logPath = `logs/${options.seat}-${calls.indexOf(call)}.log`;
    if (call.aborted) return { exitCode: 143, endedBy: 'killed', logPath };
    return { exitCode: 0, endedBy: 'exit', logPath, ...planned.result };
  };
  return { runSession, calls, maxAtOnce: () => most };
}
