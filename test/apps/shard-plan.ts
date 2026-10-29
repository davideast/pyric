#!/usr/bin/env bun
/**
 * Splits the app scenarios across CI jobs, and checks that the jobs together
 * ran every planned app exactly once.
 *
 *   bun test/apps/shard-plan.ts plan --durations <file>
 *   bun test/apps/shard-plan.ts check --reports <dir> [--durations-out <file>]
 *
 * `plan` (in the plan job) reads the times main recorded for each app, groups
 * the apps by dependency set, and packs them into shards of about
 * TARGET_SHARD_SECONDS each. It writes the plan (`app-plan`) and the matrix
 * (`app-shards`) to the step outputs. Each App scenarios job then runs
 * `run.ts --shard-plan <file> --shard <n>`, which runs that shard's apps and
 * writes a report of the apps it ran (`ShardReport`).
 *
 * `check` (in `CI / required`) reads the plan from APP_PLAN and every shard's
 * report, and fails unless each planned app ran exactly once, in the shard the
 * plan gave it. A shard that dropped an app, or never reported, cannot pass as
 * a green run. With `--durations-out` it also writes the times this run
 * measured, merged over the ones the plan read, for main to save.
 *
 * This file imports only node built-ins and the runner's own pure modules, so
 * the plan job runs it without a `bun install`.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { recordDurations, readDurations, type Durations } from './schedule.ts';
import { dependencySetKey } from './shared-installs.ts';

/**
 * The work one shard should hold, in seconds of app scenarios and installs,
 * not counting the job's setup (about 55 s).
 */
export const TARGET_SHARD_SECONDS = 90;

/**
 * The most app shards one run starts. #1571 decision 3 gives the planner a
 * budget of about 30 jobs per pull request run (the account runs 40 at once);
 * a pull request with the `ci-packaging` label starts about 22 other jobs.
 * Past this, shards get longer instead of more numerous.
 */
export const MOST_SHARDS = 8;

/** Apps a shard runs at once: one per thread of an ubuntu-latest runner, as `defaultJobs` picks on CI. */
export const APPS_AT_ONCE = 4;

/**
 * One dependency set's install on a CI runner, whose store starts empty:
 * main run 40778321565 warmed 22 sets in 0.4 to 43 s each, about 25 s typical.
 */
export const SET_INSTALL_SECONDS = 30;

/** The runner's own unit tests, which one shard runs before its apps (10 s on main run 40778321565). */
export const RUNNER_TESTS_SECONDS = 10;

/** The planned time of an app with no recorded time, when no app has one either. */
export const DEFAULT_APP_SECONDS = 120;

const PLAN_FORMAT = 1;

/** An app the plan places, with the dependency set it installs. */
export interface PlannedApp {
  name: string;
  /** The app's dependency set as `dependencySetKey` computes it, or `alone:<name>` when it installs alone. */
  set: string;
}

export interface Shard {
  /** 1-based, as the matrix and `--shard` name it. */
  index: number;
  /** The shard's apps, longest first: the order the runner starts them in. */
  apps: string[];
  /** The dependency sets the shard installs. */
  sets: string[];
  /** Whether this shard runs the runner's unit tests. Exactly one shard does. */
  runnerTests: boolean;
  predictedSeconds: number;
}

export interface AppPlan {
  format: number;
  /** Every planned app, sorted. The shards' apps together are exactly this list. */
  apps: string[];
  shards: Shard[];
  /** The planned seconds of each app: its recorded time, or the default. */
  secondsByApp: Record<string, number>;
  /** The apps that had no recorded time. */
  unrecorded: string[];
  /** The recorded times the plan read, for planned apps only. */
  durations: Durations;
}

/** What one shard's runner reports it ran. */
export interface ShardReport {
  index: number;
  apps: Array<{ name: string; ok: boolean; scenarioSeconds: number }>;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Longest first, then by name, so the plan is the same for the same inputs. */
function byTimeThenName(seconds: Record<string, number>): (a: string, b: string) => number {
  return (a, b) => seconds[b]! - seconds[a]! || a.localeCompare(b);
}

/** A group of apps of one set that is placed as a whole. */
interface Unit {
  set: string;
  apps: string[];
}

class ShardLoad {
  readonly apps: string[] = [];
  readonly sets = new Set<string>();

  constructor(readonly index: number, readonly runnerTests: boolean, private readonly seconds: Record<string, number>) {}

  /**
   * How long the shard takes: its apps and set installs spread over the
   * apps it runs at once, but never less than its longest app after that
   * app's set install, plus the runner tests when it runs them.
   */
  predicted(extra?: Unit): number {
    const apps = extra ? [...this.apps, ...extra.apps] : this.apps;
    const sets = extra ? new Set([...this.sets, extra.set]) : this.sets;
    if (apps.length === 0) return this.runnerTests ? RUNNER_TESTS_SECONDS : 0;
    const spread = (sum(apps.map((name) => this.seconds[name]!)) + sets.size * SET_INSTALL_SECONDS) / APPS_AT_ONCE;
    const longest = Math.max(...apps.map((name) => this.seconds[name]!)) + SET_INSTALL_SECONDS;
    return Math.max(spread, longest) + (this.runnerTests ? RUNNER_TESTS_SECONDS : 0);
  }

  add(unit: Unit): void {
    this.apps.push(...unit.apps);
    this.sets.add(unit.set);
  }
}

function unitSeconds(unit: Unit, seconds: Record<string, number>): number {
  const spread = (sum(unit.apps.map((name) => seconds[name]!)) + SET_INSTALL_SECONDS) / APPS_AT_ONCE;
  const longest = Math.max(...unit.apps.map((name) => seconds[name]!)) + SET_INSTALL_SECONDS;
  return Math.max(spread, longest);
}

/**
 * A set's apps as one unit, or, when the set alone holds more than a shard
 * should, as that many chunks of about equal time, each placed on its own.
 */
function setUnits(set: string, apps: string[], seconds: Record<string, number>, capacity: number): Unit[] {
  const whole = (sum(apps.map((name) => seconds[name]!)) + SET_INSTALL_SECONDS) / APPS_AT_ONCE;
  const chunks = Math.min(apps.length, Math.max(1, Math.ceil(whole / capacity)));
  const units: Unit[] = Array.from({ length: chunks }, () => ({ set, apps: [] }));
  for (const name of apps) {
    const lightest = units.reduce((best, unit) => (sum(unit.apps.map((app) => seconds[app]!)) < sum(best.apps.map((app) => seconds[app]!)) ? unit : best));
    lightest.apps.push(name);
  }
  return units;
}

/** The shard that ends up shortest with the unit on it. */
function placeUnit(shards: readonly ShardLoad[], unit: Unit): ShardLoad {
  return shards.reduce((choice, shard) => (shard.predicted(unit) < choice.predicted(unit) ? shard : choice));
}

/**
 * Packs the apps into shards. The shard count is the predicted work over
 * TARGET_SHARD_SECONDS, between 1 and MOST_SHARDS (and no more than the
 * apps). Each dependency set is placed whole, so its install runs in one
 * shard, unless it holds more than a shard's share; then it is split into
 * chunks. Units go longest first onto the shard that ends up shortest.
 */
export function planShards(planned: readonly PlannedApp[], recorded: Durations): AppPlan {
  if (planned.length === 0) throw new Error('no app scenario to plan: test/apps has no scenario.ts that is not slow');
  const apps = [...planned].sort((a, b) => a.name.localeCompare(b.name));
  const names = apps.map((app) => app.name);
  const durations = Object.fromEntries(names.filter((name) => recorded[name] !== undefined).map((name) => [name, recorded[name]!]));
  const recordedTimes = Object.values(durations);
  const fallback = recordedTimes.length > 0 ? Math.max(...recordedTimes) : DEFAULT_APP_SECONDS;
  const secondsByApp = Object.fromEntries(names.map((name) => [name, durations[name] ?? fallback]));
  const unrecorded = names.filter((name) => durations[name] === undefined);

  const bySet = new Map<string, string[]>();
  for (const app of apps) bySet.set(app.set, [...(bySet.get(app.set) ?? []), app.name]);
  const work = (sum(Object.values(secondsByApp)) + bySet.size * SET_INSTALL_SECONDS) / APPS_AT_ONCE + RUNNER_TESTS_SECONDS;
  const count = Math.min(MOST_SHARDS, names.length, Math.max(1, Math.ceil(work / TARGET_SHARD_SECONDS)));
  const capacity = work / count;

  const order = byTimeThenName(secondsByApp);
  const units = [...bySet].flatMap(([set, members]) => setUnits(set, members.sort(order), secondsByApp, capacity));
  units.sort((a, b) => unitSeconds(b, secondsByApp) - unitSeconds(a, secondsByApp) || a.apps[0]!.localeCompare(b.apps[0]!));
  const shards = Array.from({ length: count }, (_, index) => new ShardLoad(index + 1, index === 0, secondsByApp));
  for (const unit of units) placeUnit(shards, unit).add(unit);
  // A shard the units never reached would run nothing, so it is left out.
  const used = shards.filter((shard) => shard.apps.length > 0);
  return {
    format: PLAN_FORMAT,
    apps: names,
    shards: used.map((shard, position) => ({
      index: position + 1,
      apps: [...shard.apps].sort(order),
      sets: [...shard.sets].sort(),
      runnerTests: shard.runnerTests,
      predictedSeconds: shard.predicted(),
    })),
    secondsByApp,
    unrecorded,
    durations,
  };
}

/** The workspace packages that are published, so packed and pinned into every app. */
export function publishedPackageNames(root: string): string[] {
  const packagesDir = join(root, 'packages');
  return readdirSync(packagesDir)
    .map((dir) => join(packagesDir, dir, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')) as { name?: string; private?: boolean })
    .filter((manifest) => manifest.private !== true && typeof manifest.name === 'string')
    .map((manifest) => manifest.name!);
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * The app's dependency set before the run, as the runner keys it after
 * `pinPyricPackages`: every published package is pinned to a tarball, here a
 * placeholder path, since the real one is the same for every app in a run.
 * Grouping by it only decides which apps share a shard; a wrong group costs
 * an extra install, never an app.
 */
export function appSetKey(appDir: string, name: string, published: readonly string[]): string {
  const manifestFile = join(appDir, 'package.json');
  if (!existsSync(manifestFile)) return `alone:${name}`;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  const pins = Object.fromEntries(published.map((pkg) => [pkg, `file:/pyric-packages/${pkg.replace('/', '-')}.tgz`]));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const dependency of Object.keys(dependencies)) {
      if (pins[dependency]) dependencies[dependency] = pins[dependency];
    }
  }
  manifest.overrides = { ...(manifest.overrides as object | undefined), ...pins };
  const declaredName = manifest.name;
  const key = dependencySetKey({
    manifest: JSON.stringify(manifest),
    // run.ts installs each app in a directory named `app`.
    name: typeof declaredName === 'string' ? declaredName : 'app',
    npmrc: readOptional(join(appDir, '.npmrc')),
    lockfile: LOCKFILES.some((file) => existsSync(join(appDir, file))),
    bindingGyp: existsSync(join(appDir, 'binding.gyp')),
  });
  return key ?? `alone:${name}`;
}

/** `export const slow = true` at the top level of scenario.ts, the marker run.ts reads by import. */
const SLOW_MARKER = /^export const slow = true;?\s*$/m;

/**
 * The apps a `--skip-slow` run drives: each directory with a scenario.ts,
 * less the slow ones. The plan job has no `bun install`, so it reads the
 * marker as text; each shard's runner imports every scenario and fails if
 * the plan's apps differ from its own selection (`checkPlanCoversSelection`).
 */
export function discoverPlannedApps(root: string): PlannedApp[] {
  const appsDir = join(root, 'test/apps');
  const published = publishedPackageNames(root);
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, 'scenario.ts')))
    .map((entry) => entry.name)
    .filter((name) => !SLOW_MARKER.test(readFileSync(join(appsDir, name, 'scenario.ts'), 'utf8')))
    .sort()
    .map((name) => ({ name, set: appSetKey(join(appsDir, name), name, published) }));
}

/** Why the plan's apps differ from the apps this run selects, or nothing when they match. */
export function checkPlanCoversSelection(plan: AppPlan, selected: readonly string[]): string[] {
  const planned = new Set(plan.apps);
  const chosen = new Set(selected);
  return [
    ...[...chosen].filter((name) => !planned.has(name)).sort().map((name) => `the plan leaves out ${name}, which this run selects`),
    ...[...planned].filter((name) => !chosen.has(name)).sort().map((name) => `the plan names ${name}, which this run does not select`),
  ];
}

export function shardApps(plan: AppPlan, index: number): string[] {
  const shard = plan.shards.find((candidate) => candidate.index === index);
  const noun = plan.shards.length === 1 ? 'shard' : 'shards';
  if (!shard) throw new Error(`the plan has ${plan.shards.length} ${noun}, so there is no shard ${index}`);
  return shard.apps;
}

export function readPlan(text: string): AppPlan {
  const plan = JSON.parse(text) as AppPlan;
  if (plan.format !== PLAN_FORMAT) throw new Error(`the app plan has format ${String(plan.format)}, and this runner reads format ${PLAN_FORMAT}`);
  return plan;
}

export interface ShardOption {
  planFile: string;
  index: number;
}

/** Takes `--shard-plan <file>` and `--shard <n>` out of run.ts's arguments, and returns the rest. */
export function takeShardOptions(argv: readonly string[]): { argv: string[]; shard?: ShardOption } {
  const rest: string[] = [];
  let planFile: string | undefined;
  let index: string | undefined;
  for (let position = 0; position < argv.length; position++) {
    const argument = argv[position]!;
    if (argument === '--shard-plan') planFile = argv[++position];
    else if (argument === '--shard') index = argv[++position];
    else rest.push(argument);
  }
  if (planFile === undefined && index === undefined) return { argv: rest };
  if (planFile === undefined || index === undefined) throw new Error('--shard and --shard-plan go together: the plan file and the shard of it to run');
  const parsed = Number(index);
  const isShardNumber = Number.isInteger(parsed) && parsed >= 1;
  if (!isShardNumber) throw new Error(`--shard takes a whole number of at least 1, received ${index}`);
  return { argv: rest, shard: { planFile, index: parsed } };
}

export function writeShardReport(file: string, report: ShardReport): void {
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Why the shards' reports do not show every planned app run exactly once in
 * its own shard, or nothing when they do.
 */
export function checkCompleteness(plan: AppPlan, reports: readonly ShardReport[]): string[] {
  const failures: string[] = [];
  const planned = new Map(plan.shards.flatMap((shard) => shard.apps.map((name) => [name, shard.index] as const)));
  const reportsByShard = new Map<number, number>();
  for (const report of reports) reportsByShard.set(report.index, (reportsByShard.get(report.index) ?? 0) + 1);
  for (const [index, count] of [...reportsByShard].sort(([a], [b]) => a - b)) {
    const isPlannedShard = plan.shards.some((shard) => shard.index === index);
    if (!isPlannedShard) failures.push(`shard ${index} sent a report, but the plan has no such shard`);
    else if (count > 1) failures.push(`shard ${index} sent ${count} reports`);
  }
  for (const shard of plan.shards) {
    if (!reportsByShard.has(shard.index)) failures.push(`shard ${shard.index} sent no report, so its planned apps did not run: ${shard.apps.join(', ')}`);
  }
  const ranIn = new Map<string, number[]>();
  for (const report of reports) {
    for (const app of report.apps) ranIn.set(app.name, [...(ranIn.get(app.name) ?? []), report.index]);
  }
  for (const [name, shards] of [...ranIn].sort(([a], [b]) => a.localeCompare(b))) {
    if (shards.length > 1) failures.push(`${name} ran ${shards.length} times (shards ${[...shards].sort((a, b) => a - b).join(', ')})`);
  }
  for (const report of reports) {
    for (const app of report.apps) {
      const home = planned.get(app.name);
      if (home === undefined) failures.push(`${app.name} ran in shard ${report.index}, but the plan does not name it`);
      else if (home !== report.index) failures.push(`${app.name} ran in shard ${report.index}, but the plan put it in shard ${home}`);
    }
  }
  for (const [name, index] of planned) {
    const shardReported = reportsByShard.has(index);
    if (shardReported && !ranIn.has(name)) failures.push(`${name} was planned for shard ${index} but no shard ran it`);
  }
  return failures;
}

/** Writes the times the plan read, with this run's passing apps' times over them. */
export function mergeDurations(file: string, plan: AppPlan, reports: readonly ShardReport[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(plan.durations, null, 2)}\n`);
  recordDurations(file, reports.flatMap((report) => report.apps), plan.apps);
}

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function readReports(dir: string): ShardReport[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as ShardReport);
}

function runPlan(argv: readonly string[]): void {
  const root = resolve(import.meta.dir, '../..');
  const durationsFile = option(argv, '--durations');
  const plan = planShards(discoverPlannedApps(root), durationsFile ? readDurations(durationsFile) : {});
  for (const shard of plan.shards) {
    console.log(`shard ${shard.index}/${plan.shards.length}: ${shard.apps.length} apps, ${shard.sets.length} sets, about ${Math.round(shard.predictedSeconds)} s${shard.runnerTests ? ', with the runner tests' : ''}`);
    console.log(`  ${shard.apps.join(' ')}`);
  }
  if (plan.unrecorded.length) console.log(`no recorded time, planned at ${plan.secondsByApp[plan.unrecorded[0]!]} s: ${plan.unrecorded.join(', ')}`);
  const matrix = plan.shards.map((shard) => ({ index: shard.index, total: plan.shards.length, runnerTests: shard.runnerTests }));
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `app-plan=${JSON.stringify(plan)}\n`);
    appendFileSync(output, `app-shards=${JSON.stringify(matrix)}\n`);
  }
}

function runCheck(argv: readonly string[]): void {
  const text = process.env.APP_PLAN;
  if (!text) throw new Error('APP_PLAN is required: the plan job\'s app-plan output');
  const plan = readPlan(text);
  const reports = readReports(option(argv, '--reports') ?? 'test-results/app-shards');
  const durationsOut = option(argv, '--durations-out');
  if (durationsOut) mergeDurations(durationsOut, plan, reports);
  const failures = checkCompleteness(plan, reports);
  const ran = reports.reduce((total, report) => total + report.apps.length, 0);
  if (failures.length === 0) {
    console.log(`app shard completeness: ${plan.shards.length} shards ran all ${plan.apps.length} planned apps, each once (${ran} runs)`);
    return;
  }
  console.error(`app shard completeness failed: the shards ran ${ran} of ${plan.apps.length} planned apps`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'plan') runPlan(rest);
  else if (command === 'check') runCheck(rest);
  else {
    console.error('usage: bun test/apps/shard-plan.ts plan --durations <file> | check --reports <dir> [--durations-out <file>]');
    process.exit(2);
  }
}
