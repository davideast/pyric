/**
 * Starting a run or resuming one. A new run fixes its deadline now; a resumed
 * run keeps the deadline in its `run.json`, whatever `--hours` says, and its
 * timeline records the restart.
 */
import { appendTimeline } from './timeline.ts';
import {
  createRun, hasRun, readHeartbeat, readRun, readState, RunDirError, runPaths,
  type RunInfo, type RunPaths, type SupervisorState,
} from './run-dir.ts';

export interface OpenedRun {
  paths: RunPaths;
  info: RunInfo;
  state: SupervisorState;
}

export interface OpenOptions {
  runDir: string;
  hours?: number;
  resume: boolean;
  pid?: number;
  log?: (line: string) => void;
}

function resumeRun(paths: RunPaths, options: OpenOptions, now: number): OpenedRun | 'already-over' {
  const info = readRun(paths);
  const log = options.log ?? ((line: string) => console.log(line));
  if (now >= Date.parse(info.deadline)) {
    log(`the run in ${paths.root} ended at ${info.deadline}`);
    return 'already-over';
  }
  const hoursDiffer = options.hours !== undefined && options.hours !== info.hours;
  if (hoursDiffer) log(`resuming with the run's own deadline, ${info.deadline}; --hours ${options.hours} applies only to a new run`);
  const lastHeartbeat = readHeartbeat(paths)?.at;
  appendTimeline(paths.timeline, {
    type: 'restart',
    at: new Date(now).toISOString(),
    deadline: info.deadline,
    pid: options.pid ?? process.pid,
    ...(lastHeartbeat === undefined ? {} : { lastHeartbeat }),
  });
  return { paths, info, state: readState(paths) };
}

function startRun(paths: RunPaths, options: OpenOptions, now: number): OpenedRun {
  if (options.hours === undefined) throw new RunDirError(`${paths.root} holds no run to resume; pass --hours to start one`);
  const info = createRun(paths, options.hours, now);
  appendTimeline(paths.timeline, { type: 'start', at: info.startedAt, deadline: info.deadline, pid: options.pid ?? process.pid });
  return { paths, info, state: readState(paths) };
}

export function openRun(options: OpenOptions, now: number): OpenedRun | 'already-over' {
  const paths = runPaths(options.runDir);
  if (hasRun(paths) && options.resume) return resumeRun(paths, options, now);
  return startRun(paths, options, now);
}
