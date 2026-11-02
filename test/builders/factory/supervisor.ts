/**
 * The factory supervisor: keeps the roles working against one app until the
 * run's deadline, whenever and however each session ends. Only the clock
 * ends a run. A session that ends, even one whose model says it is done,
 * frees its seat for the next session; at the deadline every running session
 * is stopped.
 *
 * The supervisor holds nothing it can't read back. Its schedule state, the
 * deadline and the timeline are in the run directory (`run-dir.ts`), so a
 * supervisor started again with `resume` goes on with the same deadline.
 */
import { firstLine } from '../parse.ts';
import { systemClock, type Clock } from './clock.ts';
import { pauseAfterRateLimit } from './rate-limit.ts';
import { openRun, type OpenedRun } from './run-open.ts';
import { writeHeartbeat, writeJsonFile, writeState, type RunPaths, type SupervisorState } from './run-dir.ts';
import { MAX_SESSIONS, REVIEW_ROLES, wanted, type Start } from './schedule.ts';
import type { HourlyCheck, RunSession, SessionResult } from './session.ts';
import { noHourlyCheck } from './session.ts';
import { appendTimeline } from './timeline.ts';
import { WorkListReader } from './work-list-reader.ts';
import { readyIds } from './work-list.ts';

export const HEARTBEAT_MS = 60_000;
export const HOUR_MS = 3_600_000;
/** How long a stopped session gets to end before the supervisor stops waiting for it. */
export const KILL_GRACE_MS = 60_000;
/**
 * A session that ends sooner than this, however it exits, makes its seat wait
 * before the next, doubling each time: a model that says it is done at once
 * must not start again in a tight loop. Rate limits and the deadline aside.
 */
const SHORT_SESSION_MS = 60_000;
const FIRST_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

export interface SupervisorOptions {
  runDir: string;
  /** The run's length. Required to start a run; a resumed run keeps its own. */
  hours?: number;
  /** Go on with the run already in `runDir`, or start one when `hours` is given and there is none. */
  resume: boolean;
  /** The agent adapter's name. Required to start a run; a resumed run keeps its own. */
  agent?: string;
  /** The brief directory. Required to start a run; a resumed run keeps its own. */
  briefDir?: string;
  runSession: RunSession;
  hourlyCheck?: HourlyCheck;
  clock?: Clock;
  maxSessions?: number;
  /** Stops the run early: a signal to the supervisor, not the deadline. */
  stop?: AbortSignal;
  pid?: number;
  log?: (line: string) => void;
}

export type SupervisorOutcome = 'deadline' | 'stopped' | 'already-over';

interface Running {
  start: Start;
  startedAt: number;
  controller: AbortController;
  done: Promise<void>;
  recorded: boolean;
}

interface Cooldown {
  until: number;
  streak: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function runSupervisor(options: SupervisorOptions): Promise<SupervisorOutcome> {
  const clock = options.clock ?? systemClock;
  const opened = openRun(options, clock.now());
  if (opened === 'already-over') return 'already-over';
  return new Supervisor(options, clock, opened).run();
}

class Supervisor {
  private readonly paths: RunPaths;
  private readonly state: SupervisorState;
  private readonly startedAt: number;
  private readonly deadline: number;
  private readonly agent: string;
  private readonly briefDir: string;
  private readonly running = new Map<string, Running>();
  private readonly cooldowns = new Map<string, Cooldown>();
  private check: Promise<void> | undefined;
  private waker = new AbortController();
  /** Aborted when the run ends, for whatever is still running then. */
  private readonly halt = new AbortController();
  private lastHeartbeat = Number.NEGATIVE_INFINITY;
  private readonly log: (line: string) => void;
  private readonly pid: number;
  private readonly workList: WorkListReader;

  constructor(private readonly options: SupervisorOptions, private readonly clock: Clock, opened: OpenedRun) {
    this.paths = opened.paths;
    this.state = opened.state;
    this.startedAt = Date.parse(opened.info.startedAt);
    this.deadline = Date.parse(opened.info.deadline);
    this.agent = opened.info.agent;
    this.briefDir = opened.info.briefDir;
    this.log = options.log ?? ((line) => console.log(line));
    this.pid = options.pid ?? process.pid;
    this.workList = new WorkListReader(this.paths.files.workList, this.log);
    options.stop?.addEventListener('abort', () => this.wake(), { once: true });
  }

  async run(): Promise<SupervisorOutcome> {
    this.log(`factory run until ${iso(this.deadline)}`);
    while (this.isBeforeDeadline() && !this.isStopped()) {
      this.tick();
      await this.waitForNextEvent();
    }
    const outcome: SupervisorOutcome = this.isStopped() ? 'stopped' : 'deadline';
    await this.stopAll(outcome);
    if (outcome === 'deadline') appendTimeline(this.paths.timeline, { type: 'end', at: iso(this.clock.now()) });
    this.heartbeat(true);
    this.log(`factory run ${outcome === 'deadline' ? 'reached its deadline' : 'stopped'}`);
    return outcome;
  }

  private isBeforeDeadline(): boolean {
    return this.clock.now() < this.deadline;
  }

  private isStopped(): boolean {
    return this.options.stop?.aborted === true;
  }

  private isPaused(): boolean {
    return this.state.pausedUntil !== undefined && Date.parse(this.state.pausedUntil) > this.clock.now();
  }

  private tick(): void {
    this.heartbeat(false);
    this.oweReviewsForNewReadyWork();
    this.startHourlyCheckWhenDue();
    if (!this.isPaused()) this.startSessions();
  }

  private heartbeat(force: boolean): void {
    const now = this.clock.now();
    const isDue = now - this.lastHeartbeat >= HEARTBEAT_MS;
    if (!force && !isDue) return;
    writeHeartbeat(this.paths, now, this.pid);
    this.lastHeartbeat = now;
  }

  private saveState(): void {
    writeState(this.paths, this.state);
  }

  private oweReviews(): void {
    for (const role of REVIEW_ROLES) {
      if (!this.state.reviewsOwed.includes(role)) this.state.reviewsOwed.push(role);
    }
  }

  private oweReviewsForNewReadyWork(): void {
    const fresh = readyIds(this.workList.read(this.clock.now())).filter((id) => !this.state.readySeen.includes(id));
    if (fresh.length === 0) return;
    this.state.readySeen.push(...fresh);
    this.oweReviews();
    this.saveState();
    this.log(`work marked ready (${fresh.join(', ')}): the reviewers are owed a session`);
  }

  // The hourly check.

  private checkHourDue(): number | undefined {
    const now = this.clock.now();
    const hour = Math.floor((now - this.startedAt) / HOUR_MS);
    const isNewHour = hour > this.state.lastCheckHour;
    const isBeforeDeadline = this.startedAt + hour * HOUR_MS < this.deadline;
    const isDue = isNewHour && isBeforeDeadline && this.check === undefined;
    return isDue ? hour : undefined;
  }

  private startHourlyCheckWhenDue(): void {
    const hour = this.checkHourDue();
    if (hour === undefined) return;
    this.state.lastCheckHour = hour;
    this.saveState();
    this.log(`hourly check ${hour}`);
    this.check = this.runCheck(hour).finally(() => {
      this.check = undefined;
      this.wake();
    });
  }

  private async runCheck(hour: number): Promise<void> {
    const hook = this.options.hourlyCheck ?? noHourlyCheck;
    const context = { runDir: this.paths.root, appDir: this.paths.app, hour, signal: this.halt.signal };
    // `then` turns a synchronous throw into a rejection, so either is a failed check.
    const result = await Promise.resolve().then(() => hook(context)).catch((error: unknown) => ({ passed: false, summary: `the check threw: ${firstLine(error)}` }));
    const at = iso(this.clock.now());
    writeJsonFile(this.paths.files.latestCheck, { at, hour, ...result });
    appendTimeline(this.paths.timeline, { type: 'check', at, hour, passed: result.passed, summary: result.summary });
    this.oweReviews();
    this.saveState();
  }

  // Sessions.

  private isCooling(seat: string): boolean {
    const cooldown = this.cooldowns.get(seat);
    return cooldown !== undefined && cooldown.until > this.clock.now();
  }

  private startSessions(): void {
    const maxSessions = this.options.maxSessions ?? MAX_SESSIONS;
    const view = { state: this.state, items: this.workList.read(this.clock.now()), running: new Set(this.running.keys()) };
    const starts = wanted(view).filter((start) => !this.isCooling(start.seat.seat));
    for (const start of starts.slice(0, Math.max(0, maxSessions - this.running.size))) this.startSession(start);
  }

  private startSession(start: Start): void {
    const startedAt = this.clock.now();
    const controller = new AbortController();
    const entry: Running = { start, startedAt, controller, done: Promise.resolve(), recorded: false };
    this.log(`${iso(startedAt)} start ${start.seat.seat}`);
    entry.done = this.runOne(entry).finally(() => {
      this.running.delete(start.seat.seat);
      this.wake();
    });
    this.running.set(start.seat.seat, entry);
  }

  private async runOne(entry: Running): Promise<void> {
    const { seat, prompt } = entry.start;
    const options = {
      seat: seat.seat,
      prompt,
      runDir: this.paths.root,
      appDir: this.paths.app,
      agent: this.agent,
      briefDir: this.briefDir,
      files: this.paths.files,
      deadline: iso(this.deadline),
      remainingMs: this.deadline - entry.startedAt,
      signal: entry.controller.signal,
    };
    try {
      this.recordEnd(entry, await this.options.runSession(seat.role, options));
    } catch (error) {
      this.recordEnd(entry, { exitCode: -1, endedBy: 'exit', logPath: '' }, firstLine(error));
    }
  }

  private recordEnd(entry: Running, reported: SessionResult, error?: string): void {
    if (entry.recorded) return;
    entry.recorded = true;
    const stoppedAtDeadline = entry.controller.signal.reason === 'deadline';
    const result: SessionResult = stoppedAtDeadline ? { ...reported, endedBy: 'deadline' } : reported;
    const now = this.clock.now();
    const { seat, prompt } = entry.start;
    appendTimeline(this.paths.timeline, {
      type: 'session',
      seat: seat.seat,
      role: seat.role,
      prompt,
      start: iso(entry.startedAt),
      end: iso(now),
      endedBy: result.endedBy,
      exitCode: result.exitCode,
      logPath: result.logPath,
      ...(error === undefined ? {} : { error }),
    });
    this.log(`${iso(now)} end ${seat.seat}: ${result.endedBy}, exit ${result.exitCode}`);
    this.settleSchedule(entry, result);
    this.saveState();
  }

  /** What a session's end owes the schedule: the work it did, a pause, or a wait for its seat. */
  private settleSchedule(entry: Running, result: SessionResult): void {
    const { role, seat } = entry.start.seat;
    // A session that ran to its own end counts as the turn its seat was owed,
    // whatever its exit code, so a failing lead or reviewer isn't retried forever.
    const ranToItsEnd = result.endedBy === 'exit';
    if (ranToItsEnd) this.state.rateLimitStreak = 0;
    if (ranToItsEnd && role === 'lead') this.finishLead();
    if (ranToItsEnd && role !== 'lead' && role !== 'builder') this.finishReview(role);
    if (result.endedBy === 'rate-limit') this.pause(seat, result.resetAt);
    this.coolDown(seat, result, this.clock.now() - entry.startedAt);
  }

  private finishLead(): void {
    this.state.leadSessions += 1;
    this.state.leadOwed = false;
  }

  /** The last review of a round owes the lead its between-rounds session. */
  private finishReview(role: SupervisorState['reviewsOwed'][number]): void {
    this.state.reviewsOwed = this.state.reviewsOwed.filter((owed) => owed !== role);
    const othersRunning = REVIEW_ROLES.some((other) => other !== role && this.running.has(other));
    const isRoundOver = this.state.reviewsOwed.length === 0 && !othersRunning;
    if (isRoundOver) this.state.leadOwed = true;
  }

  private pause(seat: string, resetAt: string | undefined): void {
    this.state.rateLimitStreak += 1;
    const now = this.clock.now();
    const pause = pauseAfterRateLimit(resetAt, this.state.rateLimitStreak, now, this.deadline);
    const isLonger = this.state.pausedUntil === undefined || Date.parse(this.state.pausedUntil) < pause.until;
    if (!isLonger) return;
    this.state.pausedUntil = iso(pause.until);
    appendTimeline(this.paths.timeline, { type: 'pause', at: iso(now), until: iso(pause.until), seat, source: pause.source });
    this.log(`rate limited: no new session until ${iso(pause.until)}`);
  }

  private coolDown(seat: string, result: SessionResult, durationMs: number): void {
    const isPausedOrStopped = result.endedBy === 'rate-limit' || result.endedBy === 'deadline';
    const isQuickEnd = !isPausedOrStopped && durationMs < SHORT_SESSION_MS;
    if (!isQuickEnd) {
      this.cooldowns.delete(seat);
      return;
    }
    const streak = (this.cooldowns.get(seat)?.streak ?? 0) + 1;
    const waitMs = Math.min(MAX_COOLDOWN_MS, FIRST_COOLDOWN_MS * 2 ** (streak - 1));
    this.cooldowns.set(seat, { until: this.clock.now() + waitMs, streak });
  }

  // Waiting.

  private wake(): void {
    this.waker.abort();
  }

  private nextTimerAt(): number {
    const now = this.clock.now();
    const nextCheck = this.startedAt + (this.state.lastCheckHour + 1) * HOUR_MS;
    const times = [this.deadline, this.lastHeartbeat + HEARTBEAT_MS, nextCheck];
    if (this.state.pausedUntil !== undefined) times.push(Date.parse(this.state.pausedUntil));
    for (const cooldown of this.cooldowns.values()) times.push(cooldown.until);
    const retryAt = this.workList.retryAt(now);
    if (retryAt !== undefined) times.push(retryAt);
    return Math.min(...times.filter((time) => time > now));
  }

  private async waitForNextEvent(): Promise<void> {
    this.waker = new AbortController();
    if (this.isStopped()) return;
    await this.clock.sleep(this.nextTimerAt() - this.clock.now(), this.waker.signal);
  }

  private async stopAll(reason: SupervisorOutcome): Promise<void> {
    const entries = [...this.running.values()];
    for (const entry of entries) entry.controller.abort(reason);
    this.halt.abort(reason);
    const grace = new AbortController();
    const allDone = Promise.allSettled([...entries.map((entry) => entry.done), this.check]);
    await Promise.race([allDone, this.clock.sleep(KILL_GRACE_MS, grace.signal)]);
    grace.abort();
    const endedBy = reason === 'deadline' ? 'deadline' : 'killed';
    for (const entry of entries) this.recordEnd(entry, { exitCode: -1, endedBy, logPath: '' }, 'the session did not end within the grace period');
  }
}
