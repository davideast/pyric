/**
 * The start commit's captures, taken once per run and again only when the
 * walks change: every walked page at each width in `checks/baseline/`, the
 * "before" of each hour's gallery and what the layout gate compares with,
 * and DESIGN.md's reference screens in `checks/reference/`. It also runs
 * Studio's static gates there and records what already fails
 * (`known-failures.ts`).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPaths } from './app-paths.ts';
import { prepareCheckout, type AppRecord } from './app-setup.ts';
import { startAndWalk, staticGates } from './app-gates.ts';
import { astGrepBinary } from './ast-grep.ts';
import { writeGateLogs } from './check-output.ts';
import { knownFailuresOf, type KnownFailures } from './known-failures.ts';
import { copyWalks, REFERENCE_ROUTES, WIDTHS, writeCaptureRecord } from './captures.ts';
import { writeJsonFile } from './run-dir.ts';
import type { SandboxOpener } from './sandbox.ts';
import type { PageCapture, WalkResult } from './walk-runner.ts';

export interface BaselineState {
  startCommit: string;
  walksHash: string;
  capturedAt: string;
  /** What Studio's static gates already failed on at the start commit. */
  knownFailures: KnownFailures;
  /** Why the start commit couldn't be walked, when it couldn't. */
  error?: string;
}

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

export function referenceDir(paths: AppPaths): string {
  return join(paths.checks, 'reference');
}

function readState(paths: AppPaths): BaselineState | undefined {
  const file = stateFile(paths);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BaselineState) : undefined;
}

/** The start commit's page captures, or none when it has not been walked. */
export function baselinePages(paths: AppPaths): PageCapture[] {
  const file = join(baselineScreenshots(paths), 'walk-result.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as WalkResult).pages : [];
}

export interface BaselineInput {
  paths: AppPaths;
  record: AppRecord;
  walks: readonly string[];
  openSandbox: SandboxOpener;
  say: (line: string) => void;
}

/** Takes the start commit's captures unless this run already has them for these walks. */
export async function ensureBaseline(input: BaselineInput): Promise<BaselineState> {
  const { paths, record } = input;
  const hash = walksHash(record.briefDir);
  const current = readState(paths);
  const isCurrent = current?.startCommit === record.startCommit && current.walksHash === hash && current.knownFailures !== undefined;
  if (current !== undefined && isCurrent) return current;
  input.say(`capturing the start commit ${record.startCommit.slice(0, 12)}`);
  mkdirSync(paths.baseline, { recursive: true });
  await prepareCheckout(paths, paths.check, record.startCommit, { openSandbox: input.openSandbox, withRoot: true, say: input.say });
  const walksDir = copyWalks(record.briefDir, join(paths.check.root, 'baseline-walks'));
  const needsReference = !existsSync(join(referenceDir(paths), 'capture.json'));
  const capturedAt = new Date().toISOString();
  const astGrep = astGrepBinary(paths.check.studio);
  const { walked, statics } = await input.openSandbox(paths.check.root, paths, async (runner, namespace) => {
    const statics = await staticGates(runner, paths.check, astGrep);
    const base = { runner, namespace, checkout: paths.check, logDir: paths.baseline, walksDir };
    const walked = await startAndWalk({ ...base, walks: input.walks, outDir: baselineScreenshots(paths) });
    if (needsReference) await startAndWalk({ ...base, walks: [], routes: REFERENCE_ROUTES, outDir: referenceDir(paths) });
    return { walked, statics };
  });
  writeGateLogs(paths.baseline, statics);
  writeCaptureRecord(baselineScreenshots(paths), { commit: record.startCommit, capturedAt, widths: WIDTHS });
  if (needsReference) writeCaptureRecord(referenceDir(paths), { commit: record.startCommit, capturedAt, widths: WIDTHS, notes: ['/narration/{id}: a fresh sandbox has no narration to open'] });
  const error = walked.appStart.passed ? undefined : walked.appStart.summary;
  const knownFailures = knownFailuresOf(statics);
  const state: BaselineState = { startCommit: record.startCommit, walksHash: hash, capturedAt, knownFailures, ...(error === undefined ? {} : { error }) };
  writeJsonFile(stateFile(paths), state);
  return state;
}
