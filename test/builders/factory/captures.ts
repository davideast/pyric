/**
 * Walking and capturing a started Studio, inside the check's sandbox:
 * the brief's walk scripts, copied into the run root so the sandbox can read
 * them, run by `walk-runner.ts` under Node in Chromium. Every capture folder
 * gets `capture.json`: the commit it shows and when it was taken, so a
 * reviewer can tell whether a screenshot is newer than a change.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightBrowsersPath } from '../browser-server.ts';
import type { Runner } from './exec.ts';
import { writeJsonFile } from './run-dir.ts';
import type { WalkJob, WalkResult } from './walk-runner.ts';

const WALK_RUNNER = fileURLToPath(new URL('./walk-runner.ts', import.meta.url));
/** Playwright's client where the harness view binds it: the repo's node_modules, not bun's store behind it. */
const PLAYWRIGHT_CLIENT = fileURLToPath(new URL('../../../node_modules/@playwright/test/index.mjs', import.meta.url));
export const WIDTHS = [1440, 390];
/** DESIGN.md section 6's reference screens. A narration needs one to exist, which a fresh sandbox has not. */
export const REFERENCE_ROUTES = ['/settings', '/library', '/studio/image', '/downloads'];
const SIGN_IN_WALK = '01-sign-in.mjs';
const JOB_TIMEOUT_MS = 30 * 60_000;
export const WALK_EMAIL = 'walker@mdmedia.test';

/** The walk scripts in `<briefDir>/walks/`, by name. */
export function walkNames(briefDir: string): string[] {
  const dir = join(briefDir, 'walks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
}

/** Copies `<briefDir>/walks/` (with any shared `lib/`) under `into`, and returns where. */
export function copyWalks(briefDir: string, into: string): string {
  const target = join(into, 'walks');
  mkdirSync(target, { recursive: true });
  const source = join(briefDir, 'walks');
  if (existsSync(source)) cpSync(source, target, { recursive: true });
  return target;
}

export interface CaptureRecord {
  commit: string;
  capturedAt: string;
  widths: number[];
  /** Routes that were not captured, with why. */
  notes?: string[];
}

export function writeCaptureRecord(dir: string, record: CaptureRecord): void {
  mkdirSync(dir, { recursive: true });
  writeJsonFile(join(dir, 'capture.json'), record);
}

export interface JobInput {
  runner: Runner;
  /** A directory in the sandbox's run root, the only one it can write: the job runs and writes there. */
  stageRoot: string;
  baseURL: string;
  /** The walk scripts, inside the sandbox's run root too. */
  walksDir: string;
  walks: readonly string[];
  routes: readonly string[];
  /** Where the screenshots and result end up, on the host. */
  outDir: string;
}

/** Moves everything in `from` into `to`, replacing what is there. Both are in the run directory, so it is a rename. */
function moveInto(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) renameSync(join(from, name), join(to, name));
}

/** Runs one walk job in the sandbox and reads its result. The output goes to `<outDir>/walk-runner.log`. */
export async function runWalkJob(input: JobInput): Promise<WalkResult> {
  const stage = join(input.stageRoot, `walk-${Date.now()}`);
  const staged = join(stage, 'out');
  const job: WalkJob = {
    playwright: PLAYWRIGHT_CLIENT,
    baseURL: input.baseURL,
    walks: input.walks.map((name) => ({ name, file: join(input.walksDir, name) })),
    routes: [...input.routes],
    widths: WIDTHS,
    outDir: staged,
    ...(input.routes.length > 0 && existsSync(join(input.walksDir, SIGN_IN_WALK)) ? { routesSetup: join(input.walksDir, SIGN_IN_WALK) } : {}),
  };
  mkdirSync(staged, { recursive: true });
  const jobFile = join(stage, 'walk-job.json');
  writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  const env = { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(), MDMEDIA_WALK_EMAIL: WALK_EMAIL };
  const result = await input.runner({ command: 'node', args: [WALK_RUNNER, jobFile], cwd: stage, timeoutMs: JOB_TIMEOUT_MS, env });
  moveInto(staged, input.outDir);
  writeFileSync(join(input.outDir, 'walk-runner.log'), result.output);
  const resultFile = join(input.outDir, 'walk-result.json');
  if (!existsSync(resultFile)) throw new Error(`the walk runner wrote no result (exit ${result.code}):\n${result.output.slice(-4000)}`);
  return JSON.parse(readFileSync(resultFile, 'utf8')) as WalkResult;
}
