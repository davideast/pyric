#!/usr/bin/env bun
/**
 * Runs the app scenarios: each directory here with a `scenario.ts` is a plain
 * user project. The runner installs it from packed Pyric tarballs and real
 * registry packages, then runs its scenario against real processes and
 * Chromium.
 *
 *   bun test/apps/run.ts                     every app
 *   bun test/apps/run.ts <name> [<name>...]  the named apps
 *
 * Options:
 *   --packages <dir>  install these tarballs (also PYRIC_PACKAGE_ARTIFACT_DIR)
 *   --build           build the workspace before packing it
 *   --jobs <n>        apps run at once (default 3)
 *   --keep            keep each app's installed directory
 *
 * Without --packages, the runner packs the current workspace build into
 * dist/packages. Logs land in test-results/apps/<name>/.
 */
import { chromium, type Browser } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppRun, StepFailure, type Scenario } from './driver.ts';
import { installApp, packWorkspace, tarballsIn, type Tarballs } from './install.ts';

const appsDir = import.meta.dir;
const root = resolve(appsDir, '../..');
const resultsDir = join(root, 'test-results/apps');
const APP_TIMEOUT_MS = Number(process.env.PYRIC_APP_TIMEOUT_MS ?? 300_000);
const LOG_TAIL_LINES = 200;

interface Options {
  names: string[];
  packages?: string;
  build: boolean;
  jobs: number;
  keep: boolean;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { names: [], build: false, jobs: 3, keep: false, packages: process.env.PYRIC_PACKAGE_ARTIFACT_DIR };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--build') options.build = true;
    else if (argument === '--keep') options.keep = true;
    else if (argument === '--packages') options.packages = argv[++index];
    else if (argument === '--jobs') options.jobs = Math.max(1, Number(argv[++index]));
    else if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    else options.names.push(argument);
  }
  return options;
}

function discoverApps(): string[] {
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, 'scenario.ts')))
    .map((entry) => entry.name)
    .sort();
}

interface AppResult {
  name: string;
  ok: boolean;
  seconds: number;
  step?: string;
  error?: string;
  logs: Array<{ name: string; text: string }>;
}

function describeError(error: unknown): string {
  const cause = error instanceof StepFailure ? error.reason : error;
  return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}

function tail(text: string, lines: number): string {
  const all = text.trimEnd().split('\n');
  if (all.length <= lines) return all.join('\n');
  return [`... ${all.length - lines} earlier lines in the saved log ...`, ...all.slice(-lines)].join('\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, run: AppRun): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepFailure(run.currentStep, new Error(`the app did not finish within ${ms / 1000}s`))), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runApp(name: string, context: {
  tarballs: Tarballs;
  npmCache: string;
  keep: boolean;
  browser: () => Promise<Browser>;
}): Promise<AppResult> {
  const started = performance.now();
  const work = mkdtempSync(join(tmpdir(), `pyric-app-${name}-`));
  const projectDir = join(work, 'app');
  const home = join(work, 'home');
  mkdirSync(projectDir);
  mkdirSync(join(home, '.config'), { recursive: true });
  const run = new AppRun(name, projectDir, home, context.browser);
  const logs: AppResult['logs'] = [];
  let failure: unknown;
  try {
    run.currentStep = 'npm install';
    const install = await installApp({ appDir: join(appsDir, name), projectDir, tarballs: context.tarballs, npmCache: context.npmCache });
    logs.push({ name: 'npm install', text: install.output });
    if (install.code !== 0) throw new StepFailure('npm install', new Error(`npm install exited with code ${install.code}`));
    run.currentStep = 'load scenario';
    const module = await import(join(appsDir, name, 'scenario.ts')) as { default?: Scenario };
    if (typeof module.default !== 'function') throw new StepFailure('load scenario', new Error('scenario.ts has no default export from scenario()'));
    await withTimeout(module.default(run), APP_TIMEOUT_MS, run);
    const hostErrors = run.unexpectedHostErrors();
    if (hostErrors.length > 0) {
      throw new StepFailure('every Pyric host route the page requested answered without an error', new Error(hostErrors.join('\n')));
    }
  } catch (error) {
    failure = error;
  } finally {
    await run.close();
  }
  for (const child of run.processes) logs.push({ name: child.name, text: child.header + child.output });
  if (run.browserLog.length) logs.push({ name: 'browser', text: run.browserLog.join('\n') });
  const ok = failure === undefined;
  if (context.keep) console.log(`  ${name}: installed at ${projectDir}`);
  else rmSync(work, { recursive: true, force: true });
  return {
    name,
    ok,
    seconds: (performance.now() - started) / 1000,
    step: ok ? undefined : failure instanceof StepFailure ? failure.step : run.currentStep,
    error: ok ? undefined : describeError(failure),
    logs,
  };
}

function saveLogs(result: AppResult): string {
  const dir = join(resultsDir, result.name);
  mkdirSync(dir, { recursive: true });
  for (const [index, log] of result.logs.entries()) {
    const file = `${String(index + 1).padStart(2, '0')}-${log.name.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-|-$/g, '')}.log`;
    writeFileSync(join(dir, file.slice(0, 120)), log.text);
  }
  if (!result.ok) writeFileSync(join(dir, 'failure.txt'), `step: ${result.step}\n\n${result.error}\n`);
  return dir;
}

function report(result: AppResult, dir: string): string {
  const lines = [
    '',
    `━━━ ✗ ${result.name}: step "${result.step}" failed ━━━`,
    result.error ?? '',
  ];
  for (const log of result.logs) {
    lines.push('', `─── ${result.name} › ${log.name} ───`, tail(log.text, LOG_TAIL_LINES) || '(no output)');
  }
  lines.push('', `Full logs: ${dir}`);
  return lines.join('\n');
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const available = discoverApps();
  const unknown = options.names.filter((name) => !available.includes(name));
  if (unknown.length) {
    console.error(`unknown app: ${unknown.join(', ')}\napps: ${available.join(', ')}`);
    process.exit(2);
  }
  const names = options.names.length ? options.names : available;
  const started = performance.now();

  let tarballs: Tarballs;
  if (options.packages) {
    tarballs = tarballsIn(root, resolve(options.packages));
    console.log(`▸ installing packages from ${resolve(options.packages)}`);
  } else {
    console.log(`▸ packing the workspace${options.build ? ' (with a build)' : ' (current build)'}`);
    tarballs = await packWorkspace(root, options.build);
  }
  const npmCache = process.env.PYRIC_APPS_NPM_CACHE ?? join(homedir(), '.cache', 'pyric-app-scenarios-npm');
  rmSync(resultsDir, { recursive: true, force: true });

  let browser: Promise<Browser> | undefined;
  const launch = () => (browser ??= chromium.launch({ headless: true }));

  console.log(`▸ running ${names.length} app${names.length === 1 ? '' : 's'}, ${options.jobs} at a time`);
  const results = await pool(names, options.jobs, async (name) => {
    const result = await runApp(name, { tarballs, npmCache, keep: options.keep, browser: launch });
    const dir = saveLogs(result);
    console.log(result.ok ? `✓ ${name} (${result.seconds.toFixed(1)}s)` : report(result, dir));
    return result;
  });
  if (browser) await (await browser).close();

  const failed = results.filter((result) => !result.ok);
  const total = ((performance.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(failed.length
    ? `✗ ${failed.length} of ${results.length} apps failed (${total}s): ${failed.map((result) => `${result.name} at "${result.step}"`).join(', ')}`
    : `✓ ${results.length} apps passed (${total}s)`);
  process.exit(failed.length ? 1 : 0);
}

await main();
