#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { discoverScenarios, type Scenario } from '../../test/apps/shard-plan.ts';
import {
  requiresPackagingProof,
  selectPrCheckSet,
  type ChangedPath,
  type CheckSetInput,
} from './check-set.ts';

export function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const paths: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error('git diff emitted an empty status');
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) throw new Error(`git diff emitted an incomplete ${status} record`);
      paths.push({ path, previousPath });
      continue;
    }
    const path = fields[index++];
    if (!path) throw new Error(`git diff emitted an incomplete ${status} record`);
    paths.push({ path });
  }
  return paths;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function labels(): string[] {
  const value = process.env.CI_PR_LABELS_JSON;
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || !parsed.every((label) => typeof label === 'string')) {
    throw new Error('CI_PR_LABELS_JSON must be a JSON string array');
  }
  return parsed;
}

/** A merge group carries no labels and holds several pull requests, any of
 *  which may have asked for packaging proof, so it runs every packaging
 *  consumer rather than guess. */
function isMergeGroup(event: CheckSetInput['event']): boolean {
  return event === 'merge_group';
}

export function determinePackaging(input: {
  event: CheckSetInput['event'];
  labels: string[];
  paths: ChangedPath[];
}): boolean {
  const isPushToMain = input.event === 'push';
  return isPushToMain
    || isMergeGroup(input.event)
    || input.labels.includes('ci-packaging')
    || requiresPackagingProof(input.paths);
}

/** The release-shaped packaging consumers: the install matrix (beyond the
 *  diff-selected pull request case) and the standalone smoke. A pull request
 *  opts in with the `ci-packaging` label; a merge group always runs them. */
export function determineReleaseProof(input: {
  event: CheckSetInput['event'];
  labels: string[];
}): boolean {
  return isMergeGroup(input.event) || input.labels.includes('ci-packaging');
}

/** The code the RTDB differential gate compares: the served hosts, the RTDB
 *  and rules engines, and the gate itself. */
const RTDB_DIFFERENTIAL_INPUTS = [
  /^packages\/cli\/src\/serve\//,
  /^packages\/cli\/src\/rtdb\//,
  /^packages\/pyric\/src\/database\//,
  /^packages\/pyric\/src\/rules\//,
  /^packages\/rules\/src\//,
  /^packages\/cli\/test\/serve\/rtdb-differential\//,
  /^\.github\/workflows\/build\.yml$/,
];

export function determineRtdbDifferential(input: {
  event: CheckSetInput['event'];
  paths: ChangedPath[];
}): boolean {
  if (input.event !== 'pull_request') return true;
  const touches = (path: string): boolean => RTDB_DIFFERENTIAL_INPUTS.some((pattern) => pattern.test(path));
  return input.paths.some(({ path, previousPath }) =>
    touches(path) || (previousPath !== undefined && touches(previousPath)));
}

/** The labels that run every app scenario on a pull request. */
const EVERY_APP_LABELS = ['ci-full', 'ci-slow-scenarios'];

/**
 * The paths that build, pack and install what every scenario runs, and the
 * workflow that runs them: a change to any of them runs every app, whatever
 * the body says.
 */
const EVERY_APP_INPUTS = [
  /^\.github\/workflows\/build\.yml$/,
  /^\.github\/actions\/restore-dist\//,
  /^scripts\/ci\/build-input-key\.sh$/,
  /^scripts\/pack-packages\.sh$/,
  /^scripts\/lib\/rewrite-workspace-deps\.mjs$/,
  /^scripts\/build\.sh$/,
  /^bun\.lock$/,
  /^packages\/[^/]+\/package\.json$/,
];

/**
 * The code the scenarios run as an installed user project: the Vite plugin
 * and served hosts, the register hook and remote sandbox client, the `pyric`
 * bin and its commands, `@pyric/live`, pyric-admin and the AI broker. A
 * change to it runs SMOKE_SCENARIOS, plus the scenarios the pull request
 * changes or names.
 */
const SMOKE_INPUTS = [
  /^packages\/cli\/src\/(serve|register|remote|cli)\//,
  /^packages\/live\/src\//,
  /^packages\/pyric-admin\/src\//,
  /^packages\/pyric\/src\/ai\//,
];

/**
 * A fixed, fast set of scenarios that together drive each real entry point,
 * picked from main's recorded times (run 42331694591):
 * - live-pass-through (29 s): the Vite dev server with `pyricLive()`, a
 *   `node --import @pyric/live/register` process using firebase-admin, and
 *   the page in Chromium.
 * - served-page-imports-pyric-auth (17 s): a sandbox app on the Vite dev
 *   server with `pyric()`, signing in and reading data in Chromium.
 * - functions-http-hosted (9 s): the `pyric sandbox --hosted` command, the
 *   Node host, with a registered Node process.
 */
export const SMOKE_SCENARIOS: readonly string[] = [
  'live-pass-through',
  'served-page-imports-pyric-auth',
  'functions-http-hosted',
];

/** What the app scenario jobs run: every app that is not slow, some of them, or none. */
export type AppScenarioSelection =
  | { kind: 'all' }
  | { kind: 'some'; apps: string[] }
  | { kind: 'none' };

/**
 * The app scenario directories a pull request body names as `test/apps/<name>`
 * (AGENTS.md boundary 7 asks every body to name its integration test). Names
 * that are not scenarios, such as `test/apps/run.ts`, are left to the caller.
 */
export function scenariosNamedIn(body: string): string[] {
  const named = [...body.matchAll(/test\/apps\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)].map((match) => match[1]!);
  return [...new Set(named)];
}

/** A path under test/apps outside every scenario directory. Not a valid directory name. */
const SHARED = '\0shared';

/**
 * The scenario a changed path belongs to; SHARED for any other path under
 * test/apps (the runner, its libraries and tests, or a scenario directory
 * this checkout no longer has); nothing for a path outside test/apps.
 */
function appOfPath(path: string, scenarios: ReadonlySet<string>): string | undefined {
  const match = /^test\/apps\/(.+)$/.exec(path);
  if (!match) return undefined;
  const [first, ...rest] = match[1]!.split('/');
  const isScenarioFile = rest.length > 0 && scenarios.has(first!);
  return isScenarioFile ? first! : SHARED;
}

/**
 * The app scenarios a run drives. Outside pull requests (push to main, the
 * nightly schedule, a merge group, a manual run) and on a pull request with
 * the `ci-full` or `ci-slow-scenarios` label: every app. On any other pull
 * request: the scenarios whose files it changes and the ones its body names,
 * plus SMOKE_SCENARIOS when it changes code the scenarios run, less the slow
 * ones, which the Slow app scenarios workflow runs. A change to the runner or
 * its shared files under test/apps, or to EVERY_APP_INPUTS, changes every
 * scenario's run, so it runs every app.
 */
export function selectAppScenarios(input: {
  event: CheckSetInput['event'];
  labels: readonly string[];
  paths: readonly ChangedPath[];
  body: string;
  scenarios: readonly Scenario[];
}): AppScenarioSelection {
  if (input.event !== 'pull_request') return { kind: 'all' };
  const hasEveryAppLabel = input.labels.some((label) => EVERY_APP_LABELS.includes(label));
  if (hasEveryAppLabel) return { kind: 'all' };
  const names = new Set(input.scenarios.map((scenario) => scenario.name));
  const slow = new Set(input.scenarios.filter((scenario) => scenario.slow).map((scenario) => scenario.name));
  const touched = input.paths.flatMap(({ path, previousPath }) => (previousPath === undefined ? [path] : [path, previousPath]));
  const matchesAny = (patterns: readonly RegExp[]) => touched.some((path) => patterns.some((pattern) => pattern.test(path)));
  if (matchesAny(EVERY_APP_INPUTS)) return { kind: 'all' };
  const owners = touched.map((path) => appOfPath(path, names)).filter((owner) => owner !== undefined);
  if (owners.includes(SHARED)) return { kind: 'all' };
  const named = scenariosNamedIn(input.body).filter((name) => names.has(name));
  const smoke = matchesAny(SMOKE_INPUTS) ? SMOKE_SCENARIOS : [];
  const apps = [...new Set([...smoke, ...owners, ...named])].filter((name) => !slow.has(name)).sort();
  return apps.length === 0 ? { kind: 'none' } : { kind: 'some', apps };
}

/**
 * The `--apps` file test/apps/shard-plan.ts reads. With no app selected it
 * says every app, so the plan step still plans a matrix; the jobs then skip.
 */
export function appSelectionFile(selection: AppScenarioSelection): string {
  const apps = selection.kind === 'some' ? selection.apps : 'all';
  return `${JSON.stringify({ apps })}\n`;
}

function main(): void {
  const event = env('CI_EVENT_NAME') as CheckSetInput['event'];
  const paths = event === 'pull_request'
    ? parseNameStatus(execFileSync('git', [
      'diff', '--name-status', '-z', '--find-renames',
      `${env('CI_BASE_SHA')}...${env('CI_HEAD_SHA')}`,
    ], { encoding: 'utf8' }))
    : [];
  const prLabels = labels();
  const checkSet = selectPrCheckSet({ event, labels: prLabels, paths });
  const mode = process.env.CI_SELECTION_MODE === 'enforce' ? 'enforce' : 'shadow';
  const effectiveCheckSet = mode === 'shadow' ? 'full' : checkSet;
  // The packaging gate answers a question about published artifacts, which is
  // orthogonal to how much of the suite runs. It is forced by a push to main,
  // by the ci-packaging label, or by a diff that invalidates what it proves.
  const packaging = determinePackaging({ event, labels: prLabels, paths });
  const releaseProof = determineReleaseProof({ event, labels: prLabels });
  const rtdbDifferential = effectiveCheckSet === 'full' && determineRtdbDifferential({ event, paths });
  const root = resolve(import.meta.dir, '../..');
  const appSelection: AppScenarioSelection = effectiveCheckSet === 'full'
    ? selectAppScenarios({ event, labels: prLabels, paths, body: process.env.CI_PR_BODY ?? '', scenarios: discoverScenarios(root) })
    : { kind: 'none' };
  const appScenarios = appSelection.kind !== 'none';
  // The plan step's shard planner reads this as `--apps`.
  const selectionFile = resolve(root, 'test-results/app-selection.json');
  mkdirSync(dirname(selectionFile), { recursive: true });
  writeFileSync(selectionFile, appSelectionFile(appSelection));
  const summary = JSON.stringify(
    { mode, predictedCheckSet: checkSet, checkSet: effectiveCheckSet, packaging, releaseProof, rtdbDifferential, appScenarios, appSelection, paths },
    null,
    2,
  );
  console.log(summary);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `check-set=${effectiveCheckSet}\n`);
    appendFileSync(output, `predicted-check-set=${checkSet}\n`);
    appendFileSync(output, `packaging=${String(packaging)}\n`);
    appendFileSync(output, `release-proof=${String(releaseProof)}\n`);
    appendFileSync(output, `rtdb-differential=${String(rtdbDifferential)}\n`);
    appendFileSync(output, `app-scenarios=${String(appScenarios)}\n`);
    appendFileSync(output, `paths-json=${JSON.stringify(paths)}\n`);
  }
}

if (import.meta.main) main();
