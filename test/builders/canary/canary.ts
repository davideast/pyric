/**
 * The canary: a scripted builder with no model, and the harness's integration
 * test. It installs the packed packages into a scratch app the way a builder
 * run does, then, inside the run's network namespace, starts the app's Vite
 * dev server and a `node --import @pyric/cli/register` script under the
 * recorder and plants requests to Google hosts and the metadata server from
 * Node, from the harness browser, and from clients no recorder hooks (Bun,
 * curl). It checks that each one is in the network record and was refused by
 * the layer meant to refuse it, while a local request works and is not
 * flagged.
 *
 * Everything it makes stays under `<builders root>/canary/<stamp>/`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { takeHeavyRunSlot } from '../../../scripts/lib/heavy-run-slots.ts';
import { AppRun } from '../../apps/driver.ts';
import { npmInstall, packWorkspace, prepareApp, runCommand, tarballsIn, type Tarballs } from '../../apps/install.ts';
import { startEgressNamespace, type EgressNamespace } from '../namespace.ts';
import { browserEvents, readNetLog } from '../recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord } from '../recorder/network-record.ts';
import { buildersRoot, createRunDirs, demoProjectId, recorderEnvironment, runStamp, writeFakeFirebaseConfig, type RunDirs } from '../scratch.ts';
import { PLANTS_FILE, type PlantOutput } from './plant-phase.ts';
import { judgeCanary, type CanaryVerdict } from './verdict.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CANARY_APP = fileURLToPath(new URL('./app', import.meta.url));
const PLANT_PHASE = fileURLToPath(new URL('./plant-phase.ts', import.meta.url));
const BUILDERS_TESTS = fileURLToPath(new URL('..', import.meta.url));

const INSTALL_TIMEOUT_MS = 300_000;

export interface CanaryOptions {
  /** Build the workspace before packing it. */
  build: boolean;
  /** Install these tarballs instead of packing the workspace. */
  packages?: string;
}

function step(line: string): void {
  console.log(`▸ ${line}`);
}

async function runUnitTests(): Promise<void> {
  step('unit tests: bun test test/builders');
  const result = await runCommand('bun', ['test', BUILDERS_TESTS], { cwd: REPO_ROOT });
  if (result.code !== 0) throw new Error(`the builder unit tests failed (exit ${result.code}):\n${result.output}`);
}

async function packages(options: CanaryOptions): Promise<Tarballs> {
  if (options.packages !== undefined) {
    step(`installing packages from ${options.packages}`);
    return tarballsIn(REPO_ROOT, options.packages);
  }
  step(`packing the workspace${options.build ? ' (with a build)' : ' (current build)'}`);
  return packWorkspace(REPO_ROOT, options.build);
}

/** AppRun's own browser is never used: the plant phase drives the harness browser. */
const noDriverBrowser = (): Promise<Browser> => Promise.reject(new Error('the canary uses the harness browser server'));

/**
 * `npm install` needs the registry, so it runs before the namespace starts:
 * under the Node recorder, which refuses any Google host, but outside the
 * kernel-level block. Nothing is planted in this phase.
 */
async function install(dirs: RunDirs): Promise<void> {
  step('npm install, under the recorder, before the namespace starts');
  const app = new AppRun('builders-canary install', dirs.app, dirs.home, noDriverBrowser);
  const npmCache = process.env.PYRIC_APPS_NPM_CACHE ?? join(homedir(), '.cache', 'pyric-app-scenarios-npm');
  const recorded = recorderEnvironment(dirs.networkLog);
  try {
    const result = await npmInstall(npmCache, (args) => app.command('npm', args, { env: recorded, timeoutMs: INSTALL_TIMEOUT_MS }));
    writeFileSync(join(dirs.logs, '00-npm-install.log'), result.output);
    if (result.code !== 0) throw new Error(`npm install failed (exit ${result.code}):\n${result.output}`);
  } finally {
    await app.close();
  }
}

/** Runs the plant phase inside the run's namespace and reads what it wrote. */
async function plantInNamespace(namespace: EgressNamespace, dirs: RunDirs): Promise<PlantOutput> {
  step('plant phase, inside the network namespace');
  const { command, args } = namespace.enter(process.execPath, [PLANT_PHASE, dirs.root], REPO_ROOT);
  const result = await runCommand(command, args, { cwd: REPO_ROOT });
  process.stdout.write(result.output);
  if (result.code !== 0) throw new Error(`the plant phase exited ${result.code}`);
  return JSON.parse(readFileSync(join(dirs.root, PLANTS_FILE), 'utf8')) as PlantOutput;
}

function printVerdict(verdict: CanaryVerdict, dirs: RunDirs): void {
  console.log('');
  for (const check of verdict.checks) console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
  console.log('');
  console.log(`${verdict.googleEvents} Google-host or metadata events in ${dirs.networkLog}`);
  console.log(verdict.ok ? '✓ canary passed' : '✗ canary failed: a planted request was missed, succeeded, or was stopped by the wrong layer, or a local one was blocked');
}

/** Runs the canary. Resolves true when every check passed. */
export async function runCanary(options: CanaryOptions): Promise<boolean> {
  await runUnitTests();
  const slot = await takeHeavyRunSlot({ command: 'bun test/builders/harness.ts canary' });
  try {
    const stamp = runStamp();
    const dirs = createRunDirs(join(buildersRoot(), 'canary', stamp));
    step(`run directory ${dirs.root}`);
    // Started first, so a machine without the namespace refuses before any work.
    step('starting the network namespace: loopback only, with a recording resolver');
    const namespace = await startEgressNamespace({ networkLog: dirs.networkLog, runRoot: dirs.root });
    let output: PlantOutput;
    try {
      const tarballs = await packages(options);
      prepareApp({ appDir: CANARY_APP, projectDir: dirs.app, tarballs });
      writeFakeFirebaseConfig(dirs.app, demoProjectId(`canary-${stamp.slice(0, 10)}`));
      await install(dirs);
      output = await plantInNamespace(namespace, dirs);
    } finally {
      await namespace.stop();
    }
    appendBrowserEvents(dirs.networkLog, browserEvents(readNetLog(readFileSync(dirs.netLog, 'utf8'))));
    const verdict = judgeCanary({ ...output, record: readNetworkRecord(dirs.networkLog) });
    writeFileSync(join(dirs.root, 'canary.json'), `${JSON.stringify({ ...output, verdict }, null, 2)}\n`);
    printVerdict(verdict, dirs);
    return verdict.ok;
  } finally {
    slot.release();
  }
}
