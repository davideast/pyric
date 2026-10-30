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
 *   --jobs <n>        apps run at once (default: one per four free threads,
 *                     at most 6; one per thread on CI)
 *   --keep            keep each app's installed directory
 *   --skip-slow       leave out the apps whose scenario.ts exports `slow = true`
 *   --quarantine      let a quarantined app's scenario failure alone pass
 *                     (scripts/lib/quarantine); only CI passes it
 *   --only-slow       run only those apps
 *   --shard-plan <file> --shard <n>
 *                     run shard n of a plan from shard-plan.ts. The run
 *                     first checks that the plan's apps are exactly the
 *                     apps this run would select without it, then runs
 *                     only shard n's, and writes the apps it ran to
 *                     test-results/app-shards/shard-<n>.json for the
 *                     completeness check in `CI / required`
 *
 * A slow app waits on real timeouts. Pull requests skip it; the "Slow app
 * scenarios" workflow runs it. An app named on the command line runs either
 * way.
 *
 * Without --packages, the runner packs the current workspace build into
 * dist/packages. Apps that install the same packages share one install per
 * run, copied into each app (shared-installs.ts). Each set's tree comes from
 * the dependency store (dependency-store.ts), which keeps one installed tree
 * per third-party dependency set and installs only the run's Pyric tarballs
 * into it, offline. A set the store does not hold is warmed from the registry
 * first. The runner prints one `[runner] dependency set` line per set, with
 * where its tree came from and how long it took.
 *
 * Environment:
 *   PYRIC_APPS_DEPS_STORE  the store's directory (default
 *                          ~/.cache/pyric-app-scenarios/deps, shared by
 *                          every worktree)
 *   PYRIC_APPS_OFFLINE=1   install nothing from the registry: a set the
 *                          store does not hold fails at once, with its key
 *                          and app. A scenario's own nested install
 *                          (app.installProject, declared in
 *                          nested-projects.ts) comes from the store too
 *
 * Logs land in
 * test-results/apps/<name>/. Apps start longest first, by the times the last
 * run recorded in test-results/app-durations.json (schedule.ts).
 *
 * Every run, including one of named apps, is heavy: it takes a machine-wide
 * slot (scripts/lib/heavy-run-slots.ts) before it samples the machine and
 * packs the workspace, and waits while two other heavy runs hold both slots.
 */
import type { Browser } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanUpApp, removeTree, summarize } from './cleanup.ts';
import { AppRun, launchScenarioBrowser, StepFailure, type Scenario } from './driver.ts';
import { currentPlatform, DependencyStore, readPackedPackages } from './dependency-store.ts';
import { npmInstall, packWorkspace, prepareApp, runCommand, runTimedCommand, tarballsIn, type CommandResult, type Tarballs } from './install.ts';
import { SharedInstalls } from './shared-installs.ts';
import { takeHeavyRunSlot } from '../../scripts/lib/heavy-run-slots.ts';
import { sampleMachineLoad } from '../../scripts/lib/machine-load.ts';
import { defaultJobs, longestFirst, readDurations, recordDurations } from './schedule.ts';
import { parseArguments, selectApps, skippedSlowClause } from './selection.ts';
import { checkPlanCoversSelection, readPlan, shardApps, takeShardOptions, writeShardReport, type ShardOption } from './shard-plan.ts';
import { finishAppRun } from '../../scripts/lib/quarantine/apps.ts';
import { takeQuarantineFlag } from '../../scripts/lib/quarantine/source.ts';

const appsDir = import.meta.dir;
const root = resolve(appsDir, '../..');
const resultsDir = join(root, 'test-results/apps');
const durationsFile = join(root, 'test-results/app-durations.json');
const shardReportsDir = join(root, 'test-results/app-shards');
const APP_TIMEOUT_MS = Number(process.env.PYRIC_APP_TIMEOUT_MS ?? 300_000);
const LOG_TAIL_LINES = 200;

function discoverApps(): string[] {
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, 'scenario.ts')))
    .map((entry) => entry.name)
    .sort();
}

interface ScenarioModule {
  default?: Scenario;
  /** True for a scenario that waits on real timeouts. */
  slow?: boolean;
}

function loadScenario(name: string): Promise<ScenarioModule> {
  return import(join(appsDir, name, 'scenario.ts')) as Promise<ScenarioModule>;
}

/** The apps whose scenario.ts exports `slow = true`. Each scenario imports only the driver, Playwright, and node built-ins. */
async function slowApps(names: readonly string[]): Promise<Set<string>> {
  const modules = await Promise.all(names.map(async (name) => ({ name, module: await loadScenario(name) })));
  return new Set(modules.filter(({ module }) => module.slow === true).map(({ name }) => name));
}

interface AppResult {
  name: string;
  ok: boolean;
  seconds: number;
  /** The part of `seconds` spent on `npm install`, including waiting for a shared install. */
  installSeconds: number;
  step?: string;
  /** Whether it failed while its scenario ran, not while it installed or
   *  loaded. Only such a failure can be quarantined (scripts/lib/quarantine). */
  inScenario: boolean;
  error?: string;
  /** What went wrong closing the app or removing its directory, after its verdict was known. */
  cleanupFailures: string[];
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
  store: DependencyStore;
  installs: SharedInstalls;
  keep: boolean;
  browser: () => Promise<Browser>;
}): Promise<AppResult> {
  const started = performance.now();
  const work = mkdtempSync(join(tmpdir(), `pyric-app-${name}-`));
  const projectDir = join(work, 'app');
  const home = join(work, 'home');
  mkdirSync(projectDir);
  mkdirSync(join(home, '.config'), { recursive: true });
  const run = new AppRun(name, projectDir, home, context.browser, { tarballs: context.tarballs, store: context.store });
  const logs: AppResult['logs'] = [];
  let failure: unknown;
  let inScenario = false;
  let installSeconds = 0;
  try {
    run.currentStep = 'npm install';
    prepareApp({ appDir: join(appsDir, name), projectDir, tarballs: context.tarballs });
    const installStarted = performance.now();
    // Under the app's timeout too: a shared install or copy that never settles
    // fails this app instead of holding the run.
    const install = await withTimeout(context.installs.install(projectDir, name), APP_TIMEOUT_MS, run);
    installSeconds = (performance.now() - installStarted) / 1000;
    logs.push({ name: 'npm install', text: install.output });
    if (install.code !== 0) throw new StepFailure('npm install', new Error(`npm install exited with code ${install.code}`));
    run.currentStep = 'load scenario';
    const module = await loadScenario(name);
    if (typeof module.default !== 'function') throw new StepFailure('load scenario', new Error('scenario.ts has no default export from scenario()'));
    inScenario = true;
    await withTimeout(module.default(run), APP_TIMEOUT_MS, run);
    inScenario = false;
    const hostErrors = run.unexpectedHostErrors();
    if (hostErrors.length > 0) {
      throw new StepFailure('every Pyric host route the page requested answered without an error', new Error(hostErrors.join('\n')));
    }
    const leftovers = run.unexpectedLeftoverProcesses();
    if (leftovers.length > 0) {
      throw new StepFailure('no process an app process started outlives it holding its output', new Error(leftovers.join('\n')));
    }
  } catch (error) {
    failure = error;
  }
  // The tree is removed off the event loop, which every running app's steps
  // share. An rmSync of one app's installed tree held it for over 4 s on CI,
  // and the apps still running timed that stall as their own.
  const cleanupFailures = await cleanUpApp({
    close: () => run.close(),
    remove: async () => (context.keep ? undefined : removeTree(work)),
  });
  if (context.keep) console.log(`  ${name}: installed at ${projectDir}`);
  for (const child of run.processes) logs.push({ name: child.name, text: child.header + child.output });
  if (run.browserLog.length) logs.push({ name: 'browser', text: run.browserLog.join('\n') });
  const ok = failure === undefined;
  return {
    name,
    ok,
    seconds: (performance.now() - started) / 1000,
    installSeconds,
    step: ok ? undefined : failure instanceof StepFailure ? failure.step : run.currentStep,
    inScenario: !ok && inScenario,
    error: ok ? undefined : describeError(failure),
    cleanupFailures,
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
  if (result.cleanupFailures.length) writeFileSync(join(dir, 'cleanup-failure.txt'), `${result.cleanupFailures.join('\n')}\n`);
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

/** The install of an app that cannot share a set: from the registry, unless the run is offline. */
function installAlone(npmCache: string, offline: boolean): (cwd: string) => Promise<CommandResult> {
  if (offline) {
    const output = '[runner] this app installs alone, outside the dependency store, and PYRIC_APPS_OFFLINE=1 installs nothing from the registry\n';
    return async () => ({ code: 1, output });
  }
  return (cwd) => npmInstall(npmCache, (args) => runCommand('npm', args, { cwd }));
}

/** The dependency store for this run's tarballs, where PYRIC_APPS_DEPS_STORE points. */
async function openStore(tarballs: Tarballs, npmCache: string, offline: boolean): Promise<DependencyStore> {
  const dir = process.env.PYRIC_APPS_DEPS_STORE ?? join(homedir(), '.cache', 'pyric-app-scenarios', 'deps');
  const npmVersion = await runCommand('npm', ['--version'], { cwd: root });
  if (npmVersion.code !== 0) throw new Error(`npm --version exited with code ${npmVersion.code}:\n${npmVersion.output}`);
  console.log(`▸ dependency store ${dir}${offline ? ' (offline: a set it does not hold fails)' : ''}`);
  return new DependencyStore({
    dir,
    offline,
    packed: readPackedPackages(tarballs),
    platform: currentPlatform(npmVersion.output),
    npmCache,
    runNpm: (args, { cwd, timeoutMs }) => runTimedCommand('npm', args, { cwd, timeoutMs }),
  });
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

/** The apps of one shard of a plan, after checking the plan covers exactly the apps this run selects. */
function planShard(shard: ShardOption, selected: readonly string[]): string[] {
  const plan = readPlan(readFileSync(shard.planFile, 'utf8'));
  const mismatches = checkPlanCoversSelection(plan, selected);
  if (mismatches.length > 0) {
    console.error(`the shard plan ${shard.planFile} does not cover this run's apps:\n${mismatches.map((line) => `- ${line}`).join('\n')}`);
    process.exit(2);
  }
  return shardApps(plan, shard.index);
}

async function main(): Promise<void> {
  const { quarantine, rest: withoutQuarantine } = takeQuarantineFlag(process.argv.slice(2));
  const { argv, shard } = takeShardOptions(withoutQuarantine);
  const options = parseArguments(argv, process.env);
  if (shard && options.names.length > 0) {
    console.error('--shard runs the apps its plan gives it, so it takes no app names');
    process.exit(2);
  }
  const available = discoverApps();
  const unknown = options.names.filter((name) => !available.includes(name));
  if (unknown.length) {
    console.error(`unknown app: ${unknown.join(', ')}\napps: ${available.join(', ')}`);
    process.exit(2);
  }
  const filtersSlow = options.slow !== 'include' && options.names.length === 0;
  const slow = filtersSlow ? await slowApps(available) : new Set<string>();
  const selection = selectApps({ available, names: options.names, slow, filter: options.slow });
  const { skippedSlow } = selection;
  // Apps named on the command line run in the order given; a whole run starts the longest first.
  const isWholeRun = options.names.length === 0;
  // A shard runs its apps in the plan's order, which is longest first by main's recorded times.
  const wholeRunOrder = () => (isWholeRun ? longestFirst(selection.run, readDurations(durationsFile)) : selection.run);
  const names = shard ? planShard(shard, selection.run) : wholeRunOrder();
  await takeHeavyRunSlot();
  // Measured before packing, so the runner's own build and pack do not count as load.
  const machine = await sampleMachineLoad();
  if (names.length === 0) {
    // A run that drives no app passes without proving anything, so a marker
    // removed by mistake fails the slow workflow instead of turning it green.
    console.error(`no app is selected (${options.slow === 'only' ? 'no scenario.ts exports slow = true' : 'every app is slow'})`);
    process.exit(2);
  }
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
  const offline = process.env.PYRIC_APPS_OFFLINE === '1';
  const store = await openStore(tarballs, npmCache, offline);
  const installsDir = mkdtempSync(join(tmpdir(), 'pyric-app-installs-'));
  const installs = new SharedInstalls(installsDir, installAlone(npmCache, offline), {
    installSet: (dir, app) => store.provide(dir, app),
    report: (line) => console.log(line),
  });

  let browser: Promise<Browser> | undefined;
  const launch = () => (browser ??= launchScenarioBrowser());

  const jobs = options.jobs ?? defaultJobs(machine, process.env);
  const load = `${(machine.load / machine.threads).toFixed(2)} busy per thread`;
  console.log(`▸ running ${names.length} app${names.length === 1 ? '' : 's'}, ${jobs} at a time (${load}), longest first`);
  let results: AppResult[];
  let installsFailure: string | undefined;
  try {
    results = await pool(names, jobs, async (name) => {
      const result = await runApp(name, { tarballs, store, installs, keep: options.keep, browser: launch });
      const dir = saveLogs(result);
      // Recorded as each app finishes, so a run that stops early keeps the times it has.
      recordDurations(durationsFile, [{ name: result.name, ok: result.ok, scenarioSeconds: result.seconds - result.installSeconds }], available);
      console.log(result.ok ? `✓ ${name} (${result.seconds.toFixed(1)}s)` : report(result, dir));
      for (const cleanupFailure of result.cleanupFailures) console.log(`  warning: ${name}: cleanup failed: ${cleanupFailure}`);
      return result;
    });
    if (browser) await (await browser).close();
  } finally {
    if (options.keep) console.log(`  shared installs: ${installsDir}`);
    else installsFailure = await removeTree(installsDir);
  }

  if (shard) {
    mkdirSync(shardReportsDir, { recursive: true });
    const apps = results.map((result) => ({ name: result.name, ok: result.ok, scenarioSeconds: result.seconds - result.installSeconds }));
    writeShardReport(join(shardReportsDir, `shard-${shard.index}.json`), { index: shard.index, apps });
  }
  const total = ((performance.now() - started) / 1000).toFixed(1);
  console.log('');
  const summary = summarize(results, total, skippedSlowClause(skippedSlow));
  for (const line of summary.lines) console.log(line);
  if (installsFailure !== undefined) console.log(`warning: cleanup failed for the shared installs: ${installsFailure}`);
  // With --quarantine, which only CI passes, a failed app with an active
  // quarantine entry is reported but does not fail the run when it is the
  // only kind of failure (scripts/lib/quarantine).
  const suite = shard ? `apps-${shard.index}` : 'apps';
  process.exit(finishAppRun(suite, { apps: results, exitCode: summary.exitCode }, quarantine));
}

await main();
