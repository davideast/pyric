/**
 * When each app of a `test/apps/run.ts` run starts, and how many run at once.
 *
 * A run takes as long as its last app to finish, so the apps that took
 * longest last time start first. Each run records its passing apps' times in
 * `test-results/app-durations.json` for the next one. An app with no recorded
 * time (a new app, or a fresh checkout) starts before the timed ones, since
 * nothing says it is short.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname } from 'node:path';

/** Seconds each app took in the runs recorded so far, by app name. */
export type Durations = Record<string, number>;

export function longestFirst(names: readonly string[], durations: Durations): string[] {
  const untimed = names.filter((name) => durations[name] === undefined).sort();
  const timed = names.filter((name) => durations[name] !== undefined).sort((a, b) => (durations[b] ?? 0) - (durations[a] ?? 0));
  return [...untimed, ...timed];
}

export function readDurations(file: string): Durations {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const isRecord = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (!isRecord) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

/** Add a run's passing apps to the recorded times. A failed app's time says little, so it keeps its old one. */
export function recordDurations(file: string, results: ReadonlyArray<{ name: string; ok: boolean; seconds: number }>): void {
  const durations = readDurations(file);
  for (const result of results) {
    if (result.ok) durations[result.name] = Math.round(result.seconds * 10) / 10;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(durations, null, 2)}\n`);
}

export interface MachineLoad {
  threads: number;
  /** The one-minute load average. */
  load: number;
}

export function measureMachineLoad(): MachineLoad {
  return { threads: availableParallelism(), load: loadavg()[0] ?? 0 };
}

/** Free threads each app takes locally: its dev server, its node scripts and its Chromium pages. */
const THREADS_PER_APP = 4;
const MOST_LOCAL_JOBS = 6;

/**
 * Apps to run at once when `--jobs` is not given. A CI runner is a machine of
 * its own, so it runs one app per thread. Locally the machine is shared, so
 * the count comes from the threads the load leaves free.
 */
export function defaultJobs(machine: MachineLoad, env: Record<string, string | undefined>): number {
  const isCi = env.CI === 'true';
  if (isCi) return Math.max(1, machine.threads);
  const freeThreads = machine.threads - machine.load;
  return Math.min(MOST_LOCAL_JOBS, Math.max(1, Math.floor(freeThreads / THREADS_PER_APP)));
}
