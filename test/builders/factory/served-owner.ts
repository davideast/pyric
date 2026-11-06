/**
 * The served copy's owner: the process that started it, normally the
 * supervisor, and the run's deadline. The served copy is detached so it
 * outlives each check, but it must not outlive the run: a supervisor that
 * crashes or is killed before its run end would otherwise leave it serving
 * on the port, published, indefinitely. So it watches its owner's pid,
 * checked by start time so a reused pid never counts, and the deadline.
 */
import { startTimeOf } from '../namespace.ts';

export interface Owner {
  pid: number;
  /** The owner's start time from /proc. */
  startTime: string;
  /** The run's deadline in epoch milliseconds, when the run has one. */
  deadline?: number;
}

export const OWNER_POLL_MS = 5_000;

/** Why the served copy should stop now; undefined while its owner runs and the deadline is ahead. */
export function ownerGoneReason(owner: Owner, now: number): string | undefined {
  const isOwnerRunning = startTimeOf(owner.pid) === owner.startTime;
  if (!isOwnerRunning) return `the process that started it (pid ${owner.pid}) is gone`;
  const isPastDeadline = owner.deadline !== undefined && now >= owner.deadline;
  if (isPastDeadline) return 'the run\'s deadline passed';
  return undefined;
}

/** Calls `onGone` once, when the owner goes or the deadline passes. Returns a function that stops watching. */
export function watchOwner(owner: Owner, onGone: (reason: string) => void, pollMs = OWNER_POLL_MS, now: () => number = Date.now): () => void {
  const check = (): void => {
    const reason = ownerGoneReason(owner, now());
    if (reason === undefined) return;
    clearInterval(timer);
    onGone(reason);
  };
  const timer = setInterval(check, pollMs);
  check();
  return () => clearInterval(timer);
}

/** The owner arguments the harness passes the served process. */
export function ownerArgs(owner: Owner): string[] {
  const args = ['--owner-pid', String(owner.pid), '--owner-start', owner.startTime];
  if (owner.deadline !== undefined) args.push('--deadline', new Date(owner.deadline).toISOString());
  return args;
}

export class OwnerArgsInvalid extends Error {}

/** Reads the owner back from the served process's arguments. */
export function parseOwner(value: (flag: string) => string | undefined): Owner {
  const pid = Number(value('--owner-pid'));
  const startTime = value('--owner-start');
  const deadlineText = value('--deadline');
  if (!Number.isInteger(pid) || pid <= 0 || startTime === undefined || startTime === '') throw new OwnerArgsInvalid('the served process needs --owner-pid and --owner-start');
  if (deadlineText === undefined) return { pid, startTime };
  const deadline = Date.parse(deadlineText);
  if (Number.isNaN(deadline)) throw new OwnerArgsInvalid(`--deadline is not a time: ${deadlineText}`);
  return { pid, startTime, deadline };
}
