/**
 * The start commit's captures, taken once per run and again only when the
 * walks change, by the same path as every hour's check (`check-run.ts`):
 * every walked page at each width in `checks/baseline/`, the "before" of
 * each hour's gallery and what the layout gate compares with, and
 * DESIGN.md's reference screens in `checks/reference/`. It also records what
 * Studio's static gates already fail on there (`known-failures.ts`).
 *
 * All of it is in the run's host directory; `baseline.json` is read back
 * through its schema.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPaths } from './app-paths.ts';
import type { AppRecord } from './app-setup.ts';
import { REFERENCE_ROUTES, WIDTHS, writeCaptureRecord } from './captures.ts';
import { runTreeCheck } from './check-run.ts';
import { freshCheckDir, pointLink, writeGateLogs } from './check-output.ts';
import { knownFailuresOf } from './known-failures.ts';
import type { SandboxOpener } from './sandbox.ts';
import { baselineStateSchema, readJson, walkResultSchema, writeJson } from './state-files.ts';
import type { PageCapture } from './walk-runner.ts';
import type { z } from 'zod';

export type BaselineState = z.infer<typeof baselineStateSchema>;

function hashTree(dir: string, hash = createHash('sha256')): ReturnType<typeof createHash> {
  if (!existsSync(dir)) return hash;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hashTree(path, hash.update(`${name}/`));
    else hash.update(name).update(readFileSync(path));
  }
  return hash;
}

export function walksHash(briefDir: string): string {
  return hashTree(join(briefDir, 'walks')).digest('hex');
}

function stateFile(paths: AppPaths): string {
  return join(paths.baseline, 'baseline.json');
}

export function baselineScreenshots(paths: AppPaths): string {
  return join(paths.baseline, 'screenshots');
}

/** The start commit's page captures, or none when it has not been walked. */
export function baselinePages(paths: AppPaths): PageCapture[] {
  return readJson(join(baselineScreenshots(paths), 'walk-result.json'), walkResultSchema)?.pages ?? [];
}

export interface BaselineInput {
  paths: AppPaths;
  record: AppRecord;
  walks: readonly string[];
  signal?: AbortSignal;
  openSandbox?: SandboxOpener;
  say: (line: string) => void;
}

function isCurrent(state: BaselineState | undefined, record: AppRecord, hash: string): state is BaselineState {
  return state !== undefined && state.startCommit === record.startCommit && state.walksHash === hash;
}

/** Takes the start commit's captures unless this run already has them for these walks. */
export async function ensureBaseline(input: BaselineInput): Promise<BaselineState> {
  const { paths, record } = input;
  const hash = walksHash(record.briefDir);
  const current = readJson(stateFile(paths), baselineStateSchema);
  if (isCurrent(current, record, hash)) return current;
  input.say(`capturing the start commit ${record.startCommit.slice(0, 12)}`);
  const dir = freshCheckDir(paths, 'baseline');
  const needsReference = !existsSync(join(paths.reference, 'capture.json'));
  const referenceDir = needsReference ? freshCheckDir(paths, 'reference') : undefined;
  const capturedAt = new Date().toISOString();
  const jobs = [
    { label: 'baseline', walks: input.walks, routes: [], outDir: join(dir, 'screenshots') },
    ...(referenceDir === undefined ? [] : [{ label: 'reference', walks: [], routes: REFERENCE_ROUTES, outDir: referenceDir }]),
  ];
  const checked = await runTreeCheck({
    paths, record, commit: record.startCommit, label: 'baseline', logDir: dir, jobs, say: input.say,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.openSandbox === undefined ? {} : { openSandbox: input.openSandbox }),
  });
  writeGateLogs(dir, checked.statics);
  writeCaptureRecord(join(dir, 'screenshots'), { commit: record.startCommit, capturedAt, widths: WIDTHS });
  if (referenceDir !== undefined) {
    writeCaptureRecord(referenceDir, { commit: record.startCommit, capturedAt, widths: WIDTHS, notes: ['/narration/{id}: a fresh sandbox has no narration to open'] });
    pointLink(paths.reference, referenceDir);
  }
  const error = checked.walked.appStart.passed ? undefined : checked.walked.appStart.summary;
  const state: BaselineState = { startCommit: record.startCommit, walksHash: hash, capturedAt, knownFailures: knownFailuresOf(checked.statics), ...(error === undefined ? {} : { error }) };
  writeJson(join(dir, 'baseline.json'), state);
  pointLink(paths.baseline, dir);
  return state;
}
