// The supervisor on a fake clock with a fake session runner: hours of a run
// in milliseconds, and no real waits.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from './fake-clock.ts';
import { fakeSessions, type SessionPlan } from './fake-session.ts';
import { readHeartbeat, readRun, readState, runPaths, writeJsonFile } from './run-dir.ts';
import { PROMPTS } from './schedule.ts';
import type { HourlyCheck, RunSession } from './session.ts';
import { HEARTBEAT_MS, HOUR_MS, KILL_GRACE_MS, runSupervisor, type SupervisorOptions } from './supervisor.ts';
import { readTimeline, type TimelineLine } from './timeline.ts';
import type { WorkItem } from './work-list.ts';

const START = Date.parse('2026-11-01T22:00:00.000Z');
const MINUTE = 60_000;

type SessionLine = Extract<TimelineLine, { type: 'session' }>;

function newRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'factory-supervisor-'));
}

function writeWork(runDir: string, items: WorkItem[]): void {
  writeJsonFile(runPaths(runDir).files.workList, { items });
}

function todo(count: number): WorkItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, title: `Item ${index}`, status: 'todo' as const }));
}

function sessionLines(runDir: string): SessionLine[] {
  return readTimeline(runPaths(runDir).timeline).filter((line): line is SessionLine => line.type === 'session');
}

const BRIEF_DIR = mkdtempSync(join(tmpdir(), 'factory-brief-'));

function options(runDir: string, clock: FakeClock, runSession: SupervisorOptions['runSession'], extra: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return { runDir, hours: 1, agent: 'fake', briefDir: BRIEF_DIR, resume: false, runSession, clock, pid: 1, log: () => {}, ...extra };
}

/** Every session lasts `ms`; the lead keeps the work list stocked. */
function steady(runDir: string, ms: number): SessionPlan {
  return (role) => ({ ms, ...(role === 'lead' ? { onStart: () => writeWork(runDir, todo(3)) } : {}) });
}

describe('runSupervisor', () => {
  test('starts the next session whenever one ends, until the deadline, and none runs past it', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, steady(runDir, 7 * MINUTE));
    const outcome = await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { hours: 2 })));

    const deadline = START + 2 * HOUR_MS;
    expect(outcome).toBe('deadline');
    expect(clock.now()).toBe(deadline);
    const builder = sessionLines(runDir).filter((line) => line.seat === 'builder-1');
    // The lead's first 7 minutes, then back to back: 16 whole sessions and one the deadline stops.
    expect(builder.length).toBe(17);
    expect(builder.slice(0, -1).every((line) => line.endedBy === 'exit')).toBe(true);
    expect(builder.at(-1)?.endedBy).toBe('deadline');
    expect(sessionLines(runDir).every((line) => Date.parse(line.end) <= deadline)).toBe(true);
    expect(sessions.calls.every((call) => call.start + call.remainingMs === deadline)).toBe(true);
    expect(readTimeline(runPaths(runDir).timeline).at(-1)).toEqual({ type: 'end', at: new Date(deadline).toISOString() });
  });

  test('stops a running session at the deadline', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(1));
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, (role) => ({ ms: role === 'lead' ? MINUTE : 10 * HOUR_MS }));
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession)));

    const builder = sessions.calls.find((call) => call.seat === 'builder-1');
    expect(builder?.aborted).toBe(true);
    expect(builder?.end).toBe(START + HOUR_MS);
    const line = sessionLines(runDir).find((session) => session.seat === 'builder-1');
    expect(line).toMatchObject({ endedBy: 'deadline', exitCode: 143, end: new Date(START + HOUR_MS).toISOString() });
  });

  test('pauses new sessions until a rate limit resets, then resumes', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(2));
    const clock = new FakeClock(START);
    const resetAt = new Date(START + 30 * MINUTE).toISOString();
    const sessions = fakeSessions(clock, (role, sessionOptions, call) => {
      const isLimited = sessionOptions.seat === 'builder-1' && call === 0;
      if (isLimited) return { ms: MINUTE, result: { endedBy: 'rate-limit', exitCode: 1, resetAt } };
      return { ms: role === 'lead' ? MINUTE : 5 * MINUTE };
    });
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession)));

    const limitedAt = START + 2 * MINUTE;
    const startsDuringPause = sessions.calls.filter((call) => call.start >= limitedAt && call.start < START + 30 * MINUTE);
    expect(startsDuringPause).toEqual([]);
    expect(sessions.calls.some((call) => call.start === START + 30 * MINUTE)).toBe(true);
    const pause = readTimeline(runPaths(runDir).timeline).find((line) => line.type === 'pause');
    expect(pause).toEqual({ type: 'pause', at: new Date(limitedAt).toISOString(), until: resetAt, seat: 'builder-1', source: 'reset-at' });
  });

  test('backs off after a rate limit with no reset time', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(2));
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, (role, sessionOptions, call) => {
      const isLimited = sessionOptions.seat === 'builder-2' && call < 2;
      if (isLimited) return { ms: MINUTE, result: { endedBy: 'rate-limit', exitCode: 1 } };
      return { ms: role === 'lead' ? MINUTE : 20 * MINUTE };
    });
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession)));

    const pauses = readTimeline(runPaths(runDir).timeline).filter((line) => line.type === 'pause');
    expect(pauses).toEqual([
      { type: 'pause', at: new Date(START + 2 * MINUTE).toISOString(), until: new Date(START + 3 * MINUTE).toISOString(), seat: 'builder-2', source: 'backoff' },
      { type: 'pause', at: new Date(START + 4 * MINUTE).toISOString(), until: new Date(START + 6 * MINUTE).toISOString(), seat: 'builder-2', source: 'backoff' },
    ]);
    expect(readState(runPaths(runDir)).rateLimitStreak).toBe(0);
  });

  test('a supervisor started again resumes from disk with the same deadline', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const first = fakeSessions(clock, steady(runDir, 10 * MINUTE));
    const stop = new AbortController();
    const firstRun = runSupervisor(options(runDir, clock, first.runSession, { hours: 8, stop: stop.signal }));
    void clock.sleep(2 * HOUR_MS + 5 * MINUTE).then(() => stop.abort());
    expect(await clock.runUntilSettled(firstRun)).toBe('stopped');
    expect(readState(runPaths(runDir))).toMatchObject({ leadSessions: 2, lastCheckHour: 2 });

    const restartAt = clock.now() + 20 * MINUTE;
    await clock.advanceTo(restartAt);
    const second = fakeSessions(clock, steady(runDir, 10 * MINUTE));
    // A restart's command line names no agent or brief: the run's own come from run.json.
    const secondRun = runSupervisor(options(runDir, clock, second.runSession, { hours: 1, agent: undefined, briefDir: undefined, resume: true, pid: 2 }));
    expect(await clock.runUntilSettled(secondRun)).toBe('deadline');
    expect(readRun(runPaths(runDir))).toMatchObject({ agent: 'fake', briefDir: BRIEF_DIR });
    expect(second.calls.every((call) => call.agent === 'fake' && call.briefDir === BRIEF_DIR)).toBe(true);

    const deadline = START + 8 * HOUR_MS;
    expect(readRun(runPaths(runDir)).deadline).toBe(new Date(deadline).toISOString());
    expect(clock.now()).toBe(deadline);
    const restart = readTimeline(runPaths(runDir).timeline).find((line) => line.type === 'restart');
    expect(restart).toEqual({ type: 'restart', at: new Date(restartAt).toISOString(), deadline: new Date(deadline).toISOString(), pid: 2, lastHeartbeat: new Date(START + 2 * HOUR_MS + 5 * MINUTE).toISOString() });
    // The builders go straight back to work, since the lead's sessions are on disk, and so do
    // the reviews the hour-2 check owed when the first supervisor stopped.
    expect(second.calls.filter((call) => call.start === restartAt).map((call) => call.seat)).toEqual(['builder-1', 'builder-2', 'user-agent', 'design-reviewer']);
    const checks = readTimeline(runPaths(runDir).timeline).filter((line) => line.type === 'check').map((line) => line.hour);
    expect(checks).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('a run past its deadline does not start again', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, steady(runDir, 10 * MINUTE));
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession)));
    const count = sessions.calls.length;
    expect(await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { resume: true })))).toBe('already-over');
    expect(sessions.calls.length).toBe(count);
  });

  test('refuses a new run without an agent or a brief, or with a brief inside its directories', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, steady(runDir, 10 * MINUTE));
    await expect(runSupervisor(options(runDir, clock, sessions.runSession, { agent: undefined }))).rejects.toThrow('a new run needs --agent and --brief-dir');
    await expect(runSupervisor(options(runDir, clock, sessions.runSession, { briefDir: join(runDir, 'brief') }))).rejects.toThrow('is inside the run\'s directories');
  });

  test('refuses a run directory that holds a run without resume, and resume with nothing to resume and no hours', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, steady(runDir, 10 * MINUTE));
    const { hours: _hours, ...noHours } = options(runDir, clock, sessions.runSession, { resume: true });
    await expect(runSupervisor(noHours)).rejects.toThrow('holds no run to resume');
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession)));
    await expect(runSupervisor(options(runDir, clock, sessions.runSession))).rejects.toThrow('already holds a run; pass --resume');
  });

  test('runs the lead to plan when a builder would start with nothing on the work list', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, (role, sessionOptions, call) => {
      if (role === 'lead') return { ms: 5 * MINUTE, onStart: () => writeWork(runDir, [{ id: `plan-${call}`, title: 'Next', status: 'todo' }]) };
      // A builder finishes the one item, so the next builder finds the list empty.
      return { ms: 15 * MINUTE, onStart: () => writeWork(runDir, [{ id: `plan-${call}`, title: 'Next', status: 'done', owner: sessionOptions.seat }]) };
    });
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession)));

    const first = sessions.calls[0];
    expect(first).toMatchObject({ role: 'lead', prompt: PROMPTS.leadPlan, start: START });
    expect(sessions.calls.filter((call) => call.role === 'builder').every((call) => call.start >= START + 5 * MINUTE)).toBe(true);
    const leadStarts = sessions.calls.filter((call) => call.role === 'lead');
    expect(leadStarts.length).toBeGreaterThan(2);
    expect(leadStarts.every((call) => call.prompt === PROMPTS.leadPlan)).toBe(true);
  });

  test('never runs more than four sessions at once, and wakes the reviewers when work is ready and on the hour', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    let checks = 0;
    const hourlyCheck: HourlyCheck = async ({ hour }) => {
      checks += 1;
      return { passed: hour % 2 === 0, summary: `check ${hour}` };
    };
    const sessions = fakeSessions(clock, (role, sessionOptions, call) => {
      if (role === 'lead') return { ms: 7 * MINUTE, onStart: () => writeWork(runDir, todo(4)) };
      if (role !== 'builder') return { ms: 25 * MINUTE };
      const ready: WorkItem = { id: `${sessionOptions.seat}-${call}`, title: 'Built', status: 'ready' };
      return { ms: 13 * MINUTE, onStart: () => writeWork(runDir, [...todo(4), ready]) };
    });
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { hours: 4, hourlyCheck })));

    expect(sessions.maxAtOnce()).toBe(4);
    expect(checks).toBe(3);
    const latest = JSON.parse(readFileSync(runPaths(runDir).files.latestCheck, 'utf8')) as Record<string, unknown>;
    expect(latest).toMatchObject({ hour: 3, passed: false, summary: 'check 3' });
    const seats = new Set(sessions.calls.map((call) => call.seat));
    expect(seats).toEqual(new Set(['lead', 'builder-1', 'builder-2', 'user-agent', 'design-reviewer', 'triage']));
    // Triage sorts what the user agent and the design reviewer found, so it starts after both end.
    for (const triage of sessions.calls.filter((call) => call.seat === 'triage')) {
      const overlapping = sessions.calls.filter((call) => call.role !== 'builder' && call.role !== 'lead' && call.seat !== 'triage' && call.start < triage.start && (call.end ?? Infinity) > triage.start);
      expect(overlapping).toEqual([]);
    }
  });

  test('waits longer each time a seat fails within a minute', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(1));
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, (role, sessionOptions) => {
      if (sessionOptions.seat === 'builder-1') return { ms: 1_000, result: { exitCode: 1 } };
      return { ms: role === 'lead' ? MINUTE : HOUR_MS };
    });
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { hours: 0.25 })));

    const gaps = sessions.calls.filter((call) => call.seat === 'builder-1').map((call) => call.start - START - MINUTE).slice(0, 5);
    expect(gaps).toEqual([0, 16_000, 47_000, 108_000, 229_000]);
  });

  test('keeps the heartbeat fresh all through a long session', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(1));
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, () => ({ ms: 2 * HOUR_MS }));
    const run = runSupervisor(options(runDir, clock, sessions.runSession));
    let stalest = 0;
    for (let at = START + 7 * MINUTE; at < START + HOUR_MS; at += 7 * MINUTE) {
      await clock.advanceTo(at);
      const heartbeat = readHeartbeat(runPaths(runDir));
      stalest = Math.max(stalest, at - Date.parse(heartbeat?.at ?? new Date(START).toISOString()));
    }
    await clock.runUntilSettled(run);
    expect(stalest).toBeLessThanOrEqual(HEARTBEAT_MS);
  });

  test('ends the run after the grace period when a session ignores its signal', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(1));
    const clock = new FakeClock(START);
    const runSession: RunSession = async (role) => {
      if (role !== 'lead') return new Promise(() => {});
      await clock.sleep(MINUTE);
      return { exitCode: 0, endedBy: 'exit', logPath: '' };
    };
    const outcome = await clock.runUntilSettled(runSupervisor(options(runDir, clock, runSession)));

    expect(outcome).toBe('deadline');
    expect(clock.now()).toBe(START + HOUR_MS + KILL_GRACE_MS);
    const builder = sessionLines(runDir).find((line) => line.seat === 'builder-1');
    expect(builder).toMatchObject({ endedBy: 'deadline', exitCode: -1, error: 'the session did not end within the grace period' });
  });

  test('spaces out a seat whose sessions end within seconds, even with exit 0', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(1));
    const clock = new FakeClock(START);
    const sessions = fakeSessions(clock, (role, sessionOptions) => {
      if (sessionOptions.seat === 'builder-1') return { ms: 2_000 };
      return { ms: role === 'lead' ? MINUTE : HOUR_MS };
    });
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { hours: 0.25 })));

    const gaps = sessions.calls.filter((call) => call.seat === 'builder-1').map((call) => call.start - START - MINUTE).slice(0, 4);
    expect(gaps).toEqual([0, 17_000, 49_000, 111_000]);
  });

  test('keeps the last work list it read while the file is unreadable, and reads it again shortly', async () => {
    const runDir = newRunDir();
    const clock = new FakeClock(START);
    const logged: string[] = [];
    const workList = runPaths(runDir).files.workList;
    const sessions = fakeSessions(clock, (role, sessionOptions, call) => {
      if (role === 'lead') return { ms: 5 * MINUTE, onStart: () => writeWork(runDir, todo(2)) };
      // The first builder session leaves the list half written for a while.
      const isTearing = call === 0 && sessionOptions.seat === 'builder-1';
      if (!isTearing) return { ms: 20 * MINUTE };
      return { ms: 3 * MINUTE, onStart: () => writeFileSync(workList, '{"items": [') };
    });
    void clock.sleep(10 * MINUTE).then(() => writeWork(runDir, todo(2)));
    await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { log: (line) => logged.push(line) })));

    expect(sessions.calls.filter((call) => call.role === 'lead').length).toBe(1);
    // builder-1 goes on at 8 minutes from the last list read, with no lead session to plan.
    expect(sessions.calls.filter((call) => call.seat === 'builder-1').map((call) => call.start).slice(0, 2)).toEqual([START + 5 * MINUTE, START + 8 * MINUTE]);
    expect(logged.filter((line) => line.includes('is unreadable'))).toHaveLength(1);
  });

  test('records an hourly check that throws, at once or later, as failed and goes on', async () => {
    const runDir = newRunDir();
    writeWork(runDir, todo(1));
    const clock = new FakeClock(START);
    const hourlyCheck: HourlyCheck = (context) => {
      if (context.hour === 1) throw new Error('sync failure');
      return Promise.reject(new Error('async failure'));
    };
    const sessions = fakeSessions(clock, steady(runDir, 10 * MINUTE));
    const outcome = await clock.runUntilSettled(runSupervisor(options(runDir, clock, sessions.runSession, { hours: 3, hourlyCheck })));

    expect(outcome).toBe('deadline');
    const checks = readTimeline(runPaths(runDir).timeline).filter((line) => line.type === 'check');
    expect(checks.map((line) => line.type === 'check' && [line.hour, line.passed, line.summary])).toEqual([
      [1, false, 'the check threw: sync failure'],
      [2, false, 'the check threw: async failure'],
    ]);
  });
});
