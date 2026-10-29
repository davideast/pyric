#!/usr/bin/env bun
// Runs pyric's suites against the newest `firebase` and `firebase-admin`
// releases, so an SDK release that changes pyric's behavior shows up here
// before a user installs it. `.github/workflows/sdk-drift.yml` runs it daily.
//
//   bun scripts/ci/sdk-drift.ts run --tier=in-range|latest [--result=<path>]
//   bun scripts/ci/sdk-drift.ts file-issues --result=<path>
//
// `run` rewrites the SDK specifiers in the checkout's manifests, installs
// without the lockfile, builds, and runs the suites. It changes the checkout,
// so it belongs on a CI runner, not in a working copy. Tiers:
//   in-range  the newest release pyric's declared range allows
//   latest    npm's `latest` tag, which may be a newer major
//
// `file-issues` opens or updates one issue per package and major for a
// failed `latest` run.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openOrUpdateIssue, spawnGh } from './github-issues.ts';

export const SDK_PACKAGES = ['firebase', 'firebase-admin'] as const;
export type SdkPackage = (typeof SDK_PACKAGES)[number];
export type Tier = 'in-range' | 'latest';
export type SdkVersions = Record<SdkPackage, string>;

export interface RegistryDocument {
  'dist-tags': Record<string, string>;
  versions: Record<string, { deprecated?: string }>;
}

type Specifiers = Record<string, string>;
export interface Manifest {
  [key: string]: unknown;
  dependencies?: Specifiers;
  devDependencies?: Specifiers;
  optionalDependencies?: Specifiers;
  peerDependencies?: Specifiers;
  overrides?: Specifiers;
  workspaces?: string[];
}

const REPO_ROOT = resolve(import.meta.dir, '../..');
const RANGE_MANIFEST = 'packages/pyric/package.json';
const REWRITTEN_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const ISSUE_LABEL = 'lane:reliability';

function isStable(version: string): boolean {
  return !version.includes('-');
}

/** The version a tier tests: the newest stable, undeprecated release inside
 *  `range`, or the `latest` dist-tag. */
export function selectVersion(doc: RegistryDocument, tier: Tier, range: string): string {
  if (tier === 'latest') {
    const latest = doc['dist-tags'].latest;
    if (!latest) throw new Error('the registry document has no latest dist-tag');
    return latest;
  }
  const candidates = Object.entries(doc.versions)
    .filter(([version, meta]) => isStable(version) && meta.deprecated === undefined)
    .map(([version]) => version)
    .filter((version) => Bun.semver.satisfies(version, range))
    .sort((a, b) => Bun.semver.order(a, b));
  const newest = candidates.at(-1);
  if (!newest) throw new Error(`no stable release satisfies ${range}`);
  return newest;
}

/** pyric's declared range for each SDK, read from the pyric package manifest. */
export function declaredRanges(manifest: Manifest): SdkVersions {
  const specifiers = { ...manifest.dependencies, ...manifest.devDependencies };
  const ranges: Partial<SdkVersions> = {};
  for (const name of SDK_PACKAGES) {
    const range = specifiers[name];
    if (!range) throw new Error(`${RANGE_MANIFEST} declares no range for ${name}`);
    ranges[name] = range;
  }
  return ranges as SdkVersions;
}

function rewriteSection(section: Specifiers, versions: SdkVersions, keepReferences: boolean): Specifiers {
  const next = { ...section };
  for (const name of SDK_PACKAGES) {
    const current = next[name];
    if (current === undefined) continue;
    const isReference = current.startsWith('$');
    if (keepReferences && isReference) continue;
    next[name] = versions[name];
  }
  return next;
}

/** A copy of `manifest` with the SDK specifiers set to `versions`. Peer ranges
 *  stay, since they describe what users may install. A `$firebase` override
 *  stays a reference, so it follows the rewritten root specifier; a literal
 *  override moves with the rewrite. */
export function rewriteSpecifiers<M extends Manifest>(manifest: M, versions: SdkVersions): M {
  const next: M = { ...manifest };
  for (const key of REWRITTEN_SECTIONS) {
    const section = manifest[key];
    if (section) next[key] = rewriteSection(section, versions, false) as M[typeof key];
  }
  if (manifest.overrides) next.overrides = rewriteSection(manifest.overrides, versions, true) as M['overrides'];
  return next;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const FAIL_LINE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?$/;

/** The names of the failed tests in `bun test` output. */
export function failingTests(output: string): string[] {
  return output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => FAIL_LINE.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

function major(version: string): string {
  return version.split('.')[0] ?? version;
}

export function issueTitle(name: SdkPackage, version: string): string {
  return `pyric fails against ${name} ${version}`;
}

/** The title prefix every issue for one package and major shares. */
export function issueTitlePrefix(name: SdkPackage, version: string): string {
  return `pyric fails against ${name} ${major(version)}.`;
}

/** The packages a failed run is filed against: those that left pyric's
 *  declared range, or both when neither did, since the run cannot tell. */
export function blamedPackages(versions: SdkVersions, ranges: SdkVersions): SdkPackage[] {
  const outside = SDK_PACKAGES.filter((name) => !Bun.semver.satisfies(versions[name], ranges[name]));
  return outside.length > 0 ? outside : [...SDK_PACKAGES];
}

// ---------------------------------------------------------------------------
// The runner side: everything below changes the checkout or calls out.

interface Step {
  name: string;
  command: string[];
  /** A failure here fails the run. */
  gates: boolean;
  /** A failure here stops the run, since later steps would be meaningless. */
  required?: boolean;
}

interface StepResult {
  name: string;
  gates: boolean;
  exitCode: number;
  failingTests: string[];
}

export interface DriftResult {
  tier: Tier;
  ranges: SdkVersions;
  selected: SdkVersions;
  resolved: Partial<SdkVersions>;
  steps: StepResult[];
  failed: boolean;
  runUrl?: string;
}

const STEPS: Step[] = [
  { name: 'Build packages', command: ['bash', 'scripts/build.sh', '--packages-only'], gates: true, required: true },
  { name: 'packages/pyric', command: ['bun', 'test', '--cwd', 'packages/pyric'], gates: true },
  { name: 'packages/pyric-admin', command: ['bun', 'test', '--cwd', 'packages/pyric-admin'], gates: true },
  { name: 'packages/conformance', command: ['bun', 'test', '--cwd', 'packages/conformance'], gates: true },
  { name: 'packages/cli', command: ['bun', 'test', '--cwd', 'packages/cli'], gates: true },
  { name: 'compat:check', command: ['bun', 'run', 'compat:check'], gates: true },
  // Fails by design on any version change: observations name the version they
  // were captured on. Reported as observations to re-capture, never a gate.
  { name: 'compat:oracle-versions', command: ['bun', 'run', 'compat:oracle-versions'], gates: false },
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function fetchRegistry(name: SdkPackage): Promise<RegistryDocument> {
  const response = await fetch(`https://registry.npmjs.org/${name}`);
  if (!response.ok) throw new Error(`registry.npmjs.org/${name} answered ${response.status}`);
  return (await response.json()) as RegistryDocument;
}

function expandWorkspace(pattern: string): string[] {
  if (!pattern.endsWith('/*')) return [pattern];
  const parent = pattern.slice(0, -2);
  return readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

/** The root manifest and every workspace manifest, repo-relative. */
function manifestPaths(): string[] {
  const root = readJson<Manifest>(join(REPO_ROOT, 'package.json'));
  const workspaces = (root.workspaces ?? []).flatMap(expandWorkspace)
    .map((dir) => `${dir}/package.json`)
    .filter((path) => existsSync(join(REPO_ROOT, path)));
  return ['package.json', ...workspaces];
}

function rewriteManifests(versions: SdkVersions): void {
  for (const path of manifestPaths()) {
    const file = join(REPO_ROOT, path);
    const before = readFileSync(file, 'utf8');
    const after = `${JSON.stringify(rewriteSpecifiers(JSON.parse(before) as Manifest, versions), null, 2)}\n`;
    if (after !== before) writeFileSync(file, after);
  }
}

function resolvedVersions(): Partial<SdkVersions> {
  const resolved: Partial<SdkVersions> = {};
  for (const name of SDK_PACKAGES) {
    const file = join(REPO_ROOT, 'node_modules', name, 'package.json');
    if (existsSync(file)) resolved[name] = readJson<{ version: string }>(file).version;
  }
  return resolved;
}

/** Runs a command with its output streamed through and captured. */
function runCaptured(command: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((done) => {
    const [bin, ...args] = command;
    const child = spawn(bin ?? '', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { process.stdout.write(chunk); output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); output += chunk.toString(); });
    child.on('close', (code) => done({ exitCode: code ?? 1, output }));
  });
}

async function runStep(step: Step): Promise<StepResult> {
  console.log(`\n::group::${step.name}`);
  const { exitCode, output } = await runCaptured(step.command);
  console.log('::endgroup::');
  return { name: step.name, gates: step.gates, exitCode, failingTests: failingTests(output) };
}

function stepLine(step: StepResult): string {
  const passed = step.exitCode === 0;
  const verdict = passed ? 'passed' : step.gates ? 'failed' : 'observations to re-capture';
  return `| ${step.name} | ${verdict} | ${step.failingTests.length} |`;
}

export function summaryMarkdown(result: DriftResult): string {
  const versionRows = SDK_PACKAGES.map((name) =>
    `| ${name} | ${result.ranges[name]} | ${result.selected[name]} | ${result.resolved[name] ?? 'not installed'} |`);
  const failures = result.steps.flatMap((step) => step.failingTests.map((test) => `- ${step.name}: ${test}`));
  return [
    `## SDK drift: ${result.tier} ${result.failed ? 'failed' : 'passed'}`,
    '',
    '| Package | Declared range | Selected | Resolved in node_modules |',
    '|---|---|---|---|',
    ...versionRows,
    '',
    '| Step | Result | Failing tests |',
    '|---|---|---|',
    ...result.steps.map(stepLine),
    '',
    ...(failures.length > 0 ? ['### Failing tests', '', ...failures.slice(0, 200), ''] : []),
    ...(failures.length > 200 ? [`and ${failures.length - 200} more, in the run log.`, ''] : []),
  ].join('\n');
}

async function run(tier: Tier, resultPath: string): Promise<number> {
  const ranges = declaredRanges(readJson<Manifest>(join(REPO_ROOT, RANGE_MANIFEST)));
  const selected = {} as SdkVersions;
  for (const name of SDK_PACKAGES) selected[name] = selectVersion(await fetchRegistry(name), tier, ranges[name]);
  console.log(`Tier ${tier}: firebase ${selected.firebase}, firebase-admin ${selected['firebase-admin']}`);

  rewriteManifests(selected);
  const steps: StepResult[] = [];
  const install = await runStep({
    name: 'Install',
    command: ['bun', 'install', '--filter', '!@pyric/playground'],
    gates: true,
  });
  steps.push(install);
  const resolved = resolvedVersions();
  console.log(`Resolved: firebase ${resolved.firebase ?? 'none'}, firebase-admin ${resolved['firebase-admin'] ?? 'none'}`);

  if (install.exitCode === 0) {
    for (const step of STEPS) {
      const result = await runStep(step);
      steps.push(result);
      if (step.required && result.exitCode !== 0) break;
    }
  }

  const failed = steps.some((step) => step.gates && step.exitCode !== 0);
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const result: DriftResult = { tier, ranges, selected, resolved, steps, failed, runUrl };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = summaryMarkdown(result);
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return failed ? 1 : 0;
}

function issueBody(result: DriftResult): string {
  const run = result.runUrl ? `Run: ${result.runUrl}\n\n` : '';
  return [
    `The scheduled SDK drift job ran pyric's suites against npm's \`latest\` releases and they failed.`,
    'The job installs both packages together, so a failure may come from either one.',
    '',
    run + summaryMarkdown(result),
  ].join('\n');
}

function fileIssues(resultPath: string): void {
  const result = readJson<DriftResult>(resultPath);
  if (!result.failed) {
    console.log('The run passed; no issue to file.');
    return;
  }
  const gh = spawnGh(REPO_ROOT);
  const bodyFile = `${resultPath}.issue.md`;
  writeFileSync(bodyFile, issueBody(result));
  for (const name of blamedPackages(result.selected, result.ranges)) {
    const version = result.selected[name];
    console.log(openOrUpdateIssue(gh, {
      prefix: issueTitlePrefix(name, version),
      title: issueTitle(name, version),
      label: ISSUE_LABEL,
      bodyFile,
    }));
  }
}

function flag(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseTier(value: string | undefined): Tier {
  if (value === 'in-range' || value === 'latest') return value;
  throw new Error(`--tier must be in-range or latest, received "${value ?? ''}"`);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const resultPath = resolve(flag(args, 'result') ?? 'sdk-drift-result.json');
  if (command === 'run') {
    process.exit(await run(parseTier(flag(args, 'tier')), resultPath));
  } else if (command === 'file-issues') {
    fileIssues(resultPath);
  } else {
    console.error('usage: bun scripts/ci/sdk-drift.ts run --tier=in-range|latest [--result=<path>]');
    console.error('       bun scripts/ci/sdk-drift.ts file-issues --result=<path>');
    process.exit(2);
  }
}
