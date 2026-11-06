/**
 * Where a round's files go. Two homes, kept apart:
 *
 * - scratch, under the builders root (`~/pyric-builders`, or
 *   PYRIC_BUILDERS_DIR): `<round>/<run>/` holds the app, the run's HOME, its
 *   docs and brief, and everything the run writes while it runs, all of it
 *   bound read-write into the run's sandbox. Beside it,
 *   `<round>/<run>.model-channel.jsonl` is the model forwarder's record,
 *   which the sandbox can't see. Clearing that directory clears every run.
 * - run data, under the data root (`~/pyric-ops/assurance/builders`, or
 *   PYRIC_BUILDERS_DATA_DIR): `briefs/<round>/` (the brief writer's),
 *   `runs/<round>/<run>/` (what the harness keeps of each run), the
 *   append-only `measurements.jsonl`, and `builder.settings.json`, the
 *   Claude Code permission file builders run with.
 *
 * A reproduction (`reproduce.ts`) works in `<round>/<run>.repros/<problem>/`
 * in scratch, a fresh directory per try, and keeps what it found in
 * `runs/<round>/<run>/repros/<problem>/<stamp>/`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildersRoot, runDirsAt, type RunDirs } from './scratch.ts';

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PYRIC_BUILDERS_DATA_DIR ?? join(homedir(), 'pyric-ops', 'assurance', 'builders');
}

export const briefsDir = (round: string) => join(dataRoot(), 'briefs', round);
export const runDataDir = (round: string, run: string) => join(dataRoot(), 'runs', round, run);
export const measurementsFile = () => join(dataRoot(), 'measurements.jsonl');
export const builderSettingsFile = () => join(dataRoot(), 'builder.settings.json');

/** A builder run's scratch paths: the canary's, plus what a builder reads and writes. */
export interface BuilderRunDirs extends RunDirs {
  docs: string;
  briefText: string;
  briefJson: string;
  /** Where the builder writes its report. */
  report: string;
  /** The model channel's Unix socket (`model-channel.ts`). Kept short: a socket path has a length limit. */
  modelSocket: string;
  /** Written once the run's sandbox has started: from then on the run exists, and a round never redoes it. */
  started: string;
  /** What the run phase is told to start, and what it saw. */
  phase: string;
  phaseResult: string;
}

export function builderRunDirsAt(root: string): BuilderRunDirs {
  return {
    ...runDirsAt(root),
    docs: join(root, 'docs'),
    briefText: join(root, 'brief.md'),
    briefJson: join(root, 'brief.json'),
    report: join(root, 'report.json'),
    modelSocket: join(root, 'model.sock'),
    started: join(root, 'sandbox-started'),
    phase: join(root, 'phase.json'),
    phaseResult: join(root, 'phase-result.json'),
  };
}

export const builderRunRoot = (round: string, run: string) => join(buildersRoot(), round, run);

/** The forwarder's record of a run, outside the run root, so nothing in the sandbox can write it. */
export const channelRecordFile = (round: string, run: string) => join(buildersRoot(), round, `${run}.model-channel.jsonl`);

/** Where one try of a reproduction runs: a fresh scratch directory beside the run's. */
export const reproTryRoot = (round: string, run: string, problem: string, stamp: string, attempt: number) =>
  join(buildersRoot(), round, `${run}.repros`, problem, `${stamp}-try-${attempt}`);

/** Where a reproduction keeps what it found, inside the run's data. */
export const reproDataDir = (round: string, run: string, problem: string, stamp: string) => join(runDataDir(round, run), 'repros', problem, stamp);
