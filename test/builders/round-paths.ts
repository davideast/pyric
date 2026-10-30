/**
 * Where a round's files go. Two homes, kept apart:
 *
 * - scratch, under the builders root (`~/pyric-builders`, or
 *   PYRIC_BUILDERS_DIR): `<round>/<run>/` holds the app, the run's HOME, its
 *   docs and brief, and everything the run writes while it runs. Clearing
 *   that directory clears every run.
 * - run data, under the data root (`~/pyric-ops/assurance/builders`, or
 *   PYRIC_BUILDERS_DATA_DIR): `briefs/<round>/` (the brief writer's),
 *   `runs/<round>/<run>/` (what the harness keeps of each run), the
 *   append-only `measurements.jsonl`, and `builder.settings.json`, the
 *   Claude Code permission file builders run with.
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
    phase: join(root, 'phase.json'),
    phaseResult: join(root, 'phase-result.json'),
  };
}

export const builderRunRoot = (round: string, run: string) => join(buildersRoot(), round, run);
