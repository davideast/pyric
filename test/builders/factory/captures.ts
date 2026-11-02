/**
 * Walking and capturing a started Studio from the walk sandbox: a sandbox of
 * its own whose root nothing but the walk runner writes. The brief's walk
 * scripts are bound read-only from the brief directory, outside every
 * sandbox's writable root; `walk-runner.ts` runs them under Node in
 * Chromium against Studio at 127.0.0.1, which the relay carries to Studio's
 * sandbox. The result and the screenshots are read from the walk sandbox's
 * root, through a schema, into the run's host directory. Every capture
 * folder gets `capture.json`: the commit it shows and when it was taken.
 */
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightBrowsersPath } from '../browser-server.ts';
import type { Runner } from './exec.ts';
import { openNewFile, writeNewFile } from './host-files.ts';
import { optional } from './optional.ts';
import { readJson, walkResultSchema, writeJson, type CaptureRecord } from './state-files.ts';
import type { WalkJob, WalkResult } from './walk-runner.ts';

export type { CaptureRecord } from './state-files.ts';

const WALK_RUNNER = fileURLToPath(new URL('./walk-runner.ts', import.meta.url));
/** Playwright's client where the harness view binds it: the repo's node_modules, not bun's store behind it. */
export const PLAYWRIGHT_CLIENT = fileURLToPath(new URL('../../../node_modules/@playwright/test/index.mjs', import.meta.url));
export const WIDTHS = [1440, 390];
/** DESIGN.md section 6's reference screens. A narration needs one to exist, which a fresh sandbox has not. */
export const REFERENCE_ROUTES = ['/settings', '/library', '/studio/image', '/downloads'];
const SIGN_IN_WALK = '01-sign-in.mjs';
const JOB_TIMEOUT_MS = 30 * 60_000;
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
export const WALK_EMAIL = 'walker@mdmedia.test';

/** The walk scripts in `<briefDir>/walks/`, by name. */
export function walkNames(briefDir: string): string[] {
  const dir = join(briefDir, 'walks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
}

export function writeCaptureRecord(dir: string, record: CaptureRecord): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'capture.json'), record);
}

export interface JobInput {
  /** Runs in the walk sandbox. */
  runner: Runner;
  /** The walk sandbox's root: the job's files go in a fresh folder there. */
  root: string;
  label: string;
  baseURL: string;
  briefDir: string;
  walks: readonly string[];
  routes: readonly string[];
  /** Where the screenshots and result end up, in the run's host directory. */
  outDir: string;
}

class CaptureError extends Error {}

/** Copies a regular file of the walk sandbox's into a new file of the host's, never through a link. */
function copyOut(from: string, to: string): void {
  const source = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(source);
    const isSmallFile = stat.isFile() && stat.size <= MAX_SCREENSHOT_BYTES;
    if (!isSmallFile) throw new CaptureError(`${from} is not a regular file of at most ${MAX_SCREENSHOT_BYTES} bytes`);
    const target = openNewFile(to);
    try {
      writeSync(target, readFileSync(source));
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
}

function jobOf(input: JobInput, staged: string): WalkJob {
  const walksDir = join(input.briefDir, 'walks');
  const hasSignIn = input.routes.length > 0 && existsSync(join(walksDir, SIGN_IN_WALK));
  return {
    playwright: PLAYWRIGHT_CLIENT,
    baseURL: input.baseURL,
    walks: input.walks.map((name) => ({ name, file: join(walksDir, name) })),
    routes: [...input.routes],
    widths: WIDTHS,
    outDir: staged,
    ...optional('routesSetup', hasSignIn ? join(walksDir, SIGN_IN_WALK) : undefined),
  };
}

/** Runs one walk job in the walk sandbox and copies its result and screenshots out. The output goes to `<outDir>/walk-runner.log`. */
export async function runWalkJob(input: JobInput): Promise<WalkResult> {
  const stage = join(input.root, input.label);
  const staged = join(stage, 'out');
  mkdirSync(staged, { recursive: true });
  const jobFile = join(stage, 'walk-job.json');
  writeNewFile(jobFile, `${JSON.stringify(jobOf(input, staged), null, 2)}\n`);
  const env = { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(), MDMEDIA_WALK_EMAIL: WALK_EMAIL };
  const result = await input.runner({ command: 'node', args: [WALK_RUNNER, jobFile], cwd: stage, timeoutMs: JOB_TIMEOUT_MS, env });
  mkdirSync(input.outDir, { recursive: true });
  writeNewFile(join(input.outDir, 'walk-runner.log'), result.output);
  const walked = readJson(join(staged, 'walk-result.json'), walkResultSchema);
  if (walked === undefined) throw new CaptureError(`the walk runner wrote no result (exit ${result.code}):\n${result.output.slice(-4000)}`);
  const screenshots = new Set(walked.pages.map((page) => page.screenshot));
  for (const name of screenshots) {
    const shot = join(staged, name);
    if (existsSync(shot)) copyOut(shot, join(input.outDir, name));
  }
  writeJson(join(input.outDir, 'walk-result.json'), walked);
  return walked;
}
