/**
 * A factory run's directories. Everything the run needs to go on lives in
 * them, not in the supervisor's memory, so a restarted supervisor resumes
 * where the last one stopped.
 *
 * The run directory is what every session's sandbox can write:
 *
 *   work-list.json      the items the lead plans and the builders take
 *   progress.md         notes every session reads and adds to
 *   latest-check.json   the last hourly check's result
 *   app/                the app repo every role works in
 *   homes/              each seat's HOME
 *   logs/               each sandbox's network record
 *
 * The run's host directory, `<run dir>.host/` beside it, is the harness's
 * alone; no sandbox binds it writable (`host-files.ts`):
 *
 *   run.json            the start, the deadline, the agent and the brief, fixed when the run starts
 *   supervisor.json     the schedule's state: reviews owed, the lead owed, a pause
 *   heartbeat.json      the supervisor's last sign of life, every minute
 *   timeline.jsonl      one line per session, pause, restart and hourly check
 *   logs/               each session's agent output
 *   channel/            each seat's forwarder record
 *   s/                  each session's phase file and forwarder socket
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonText, parseWith } from '../parse.ts';
import { hostDirOf, isInside, makeHostDir, replaceFile } from './host-files.ts';

export interface StateFiles {
  workList: string;
  progress: string;
  latestCheck: string;
}

export interface RunPaths {
  root: string;
  /** The run's host directory. */
  host: string;
  run: string;
  supervisor: string;
  heartbeat: string;
  timeline: string;
  app: string;
  logs: string;
  files: StateFiles;
}

export function runPaths(root: string): RunPaths {
  const host = hostDirOf(root);
  return {
    root,
    host,
    run: join(host, 'run.json'),
    supervisor: join(host, 'supervisor.json'),
    heartbeat: join(host, 'heartbeat.json'),
    timeline: join(host, 'timeline.jsonl'),
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
  /** The agent adapter every session uses, by name. */
  agent: z.string().min(1),
  /** The brief directory every session reads. */
  briefDir: z.string().min(1),
}).strict();

export type RunInfo = z.infer<typeof runSchema>;

const heartbeatSchema = z.object({ at: isoTime, pid: z.number().int() }).strict();

export type Heartbeat = z.infer<typeof heartbeatSchema>;

export class RunDirError extends Error {}

/** Writes through a fresh sibling file and a rename, so a crash never leaves half a file and a planted link is replaced, never followed. */
export function writeJsonFile(path: string, value: unknown): void {
  replaceFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const text = parseJsonText(readFileSync(path, 'utf8'));
  const parsed = text.ok ? parseWith(schema, text.value) : text;
  if (!parsed.ok) throw new RunDirError(`${path}: ${parsed.errors.join('; ')}`);
  return parsed.value;
}

/** What a new run is started with. */
export interface RunStart {
  hours: number;
  agent: string;
  briefDir: string;
}

/** Fixes the run's deadline, `hours` from `now`, with its agent and brief, and lays out both directories. */
export function createRun(paths: RunPaths, start: RunStart, now: number): RunInfo {
  if (existsSync(paths.run)) throw new RunDirError(`${paths.root} already holds a run; pass --resume to go on with it`);
  const briefIsInside = isInside(start.briefDir, paths.root) || isInside(start.briefDir, paths.host);
  if (briefIsInside) throw new RunDirError(`the brief directory ${start.briefDir} is inside the run's directories; put it outside them, where no session can write it`);
  const info: RunInfo = {
    startedAt: new Date(now).toISOString(),
    deadline: new Date(now + start.hours * 3_600_000).toISOString(),
    hours: start.hours,
    agent: start.agent,
    briefDir: start.briefDir,
  };
  for (const dir of [paths.root, paths.app, paths.logs]) mkdirSync(dir, { recursive: true });
  makeHostDir(paths.host, paths.host, paths.root);
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
