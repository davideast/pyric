/**
 * A factory run's directory. Everything the run needs to go on lives here,
 * not in the supervisor's memory, so a restarted supervisor resumes where the
 * last one stopped:
 *
 *   run.json            the start and the deadline, fixed when the run starts
 *   supervisor.json     the schedule's state: reviews owed, the lead owed, a pause
 *   heartbeat.json      the supervisor's last sign of life, every minute
 *   timeline.jsonl      one line per session, pause, restart and hourly check
 *   work-list.json      the items the lead plans and the builders take
 *   progress.md         notes every session reads and adds to
 *   latest-check.json   the last hourly check's result
 *   app/                the app repo every role works in
 *   logs/               the sessions' logs
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonText, parseWith } from '../parse.ts';

export interface StateFiles {
  workList: string;
  progress: string;
  latestCheck: string;
}

export interface RunPaths {
  root: string;
  run: string;
  supervisor: string;
  heartbeat: string;
  timeline: string;
  app: string;
  logs: string;
  files: StateFiles;
}

export function runPaths(root: string): RunPaths {
  return {
    root,
    run: join(root, 'run.json'),
    supervisor: join(root, 'supervisor.json'),
    heartbeat: join(root, 'heartbeat.json'),
    timeline: join(root, 'timeline.jsonl'),
    app: join(root, 'app'),
    logs: join(root, 'logs'),
    files: {
      workList: join(root, 'work-list.json'),
      progress: join(root, 'progress.md'),
      latestCheck: join(root, 'latest-check.json'),
    },
  };
}

const isoTime = z.string().datetime();

const runSchema = z.object({
  startedAt: isoTime,
  deadline: isoTime,
  hours: z.number().positive(),
}).strict();

export type RunInfo = z.infer<typeof runSchema>;

const heartbeatSchema = z.object({ at: isoTime, pid: z.number().int() }).strict();

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export class RunDirError extends Error {}

/** Writes through a sibling file and a rename, so a crash never leaves half a file. */
export function writeJsonFile(path: string, value: unknown): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(partial, path);
}

function readJsonFile<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const text = parseJsonText(readFileSync(path, 'utf8'));
  const parsed = text.ok ? parseWith(schema, text.value) : text;
  if (!parsed.ok) throw new RunDirError(`${path}: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

/** Fixes the run's deadline, `hours` from `now`, and lays out the directory. */
export function createRun(paths: RunPaths, hours: number, now: number): RunInfo {
  if (existsSync(paths.run)) throw new RunDirError(`${paths.root} already holds a run; pass --resume to go on with it`);
  const info: RunInfo = {
    startedAt: new Date(now).toISOString(),
    deadline: new Date(now + hours * 3_600_000).toISOString(),
    hours,
  };
  for (const dir of [paths.root, paths.app, paths.logs]) mkdirSync(dir, { recursive: true });
  writeJsonFile(paths.run, info);
  return info;
}

export function hasRun(paths: RunPaths): boolean {
  return existsSync(paths.run);
}

export function readRun(paths: RunPaths): RunInfo {
  return readJsonFile(paths.run, runSchema);
}

export function writeHeartbeat(paths: RunPaths, now: number, pid: number): void {
  writeJsonFile(paths.heartbeat, { at: new Date(now).toISOString(), pid });
}

export function readHeartbeat(paths: RunPaths): Heartbeat | undefined {
  if (!existsSync(paths.heartbeat)) return undefined;
  return readJsonFile(paths.heartbeat, heartbeatSchema);
}

export const supervisorStateSchema = z.object({
  /** Lead sessions finished so far. Builders wait for the first. */
  leadSessions: z.number().int().nonnegative(),
  /** The lead is owed a session: at the start, and after each round of reviews. */
  leadOwed: z.boolean(),
  /** On-demand roles owed a session, from an hourly check or work marked ready. */
  reviewsOwed: z.array(z.enum(['user-agent', 'design-reviewer', 'triage'])),
  /** Ready items the on-demand roles have already been woken for. */
  readySeen: z.array(z.string()),
  /** The last hourly check called, in whole hours since the start. */
  lastCheckHour: z.number().int().nonnegative(),
  /** No session starts before this ISO time. */
  pausedUntil: isoTime.optional(),
  /** Rate limits in a row, for the backoff when one gives no reset time. */
  rateLimitStreak: z.number().int().nonnegative(),
}).strict();

export type SupervisorState = z.infer<typeof supervisorStateSchema>;

export function initialState(): SupervisorState {
  return { leadSessions: 0, leadOwed: true, reviewsOwed: [], readySeen: [], lastCheckHour: 0, rateLimitStreak: 0 };
}

export function readState(paths: RunPaths): SupervisorState {
  if (!existsSync(paths.supervisor)) return initialState();
  return readJsonFile(paths.supervisor, supervisorStateSchema);
}

export function writeState(paths: RunPaths, state: SupervisorState): void {
  writeJsonFile(paths.supervisor, state);
}
