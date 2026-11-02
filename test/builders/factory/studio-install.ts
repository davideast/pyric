/**
 * Installs Studio in a tree, every step inside the tree's sandbox, where no
 * network but loopback exists:
 *
 * - With `withRoot`, the repo root's packages for Studio's tests: `bun
 *   install --frozen-lockfile --ignore-scripts` from the host's bun cache,
 *   bound under an overlay so the install can't change it. A lockfile entry
 *   that names a source other than the npm registry fails first, named.
 * - Studio's packages: npm from the warm shared cache (`app-install.ts`),
 *   never on the host. A cold cache fails and names the package it lacks;
 *   setup's install warms the cache.
 * - Studio's own postinstall patch, which `--ignore-scripts` skipped.
 * - The functions package, built: `pyric sandbox` refuses to start when
 *   firebase.json declares a Functions source whose entry is missing, and
 *   Studio's (`../functions`) is build output no commit has.
 * - The factory's UI rules, copied into `studio/checks/`, where Studio's
 *   ast-grep config names them since the start commit.
 * - `studio/.env.local` with the placeholder web config `app-start.ts`
 *   passes, so a role that runs `npm run dev` itself gets the same values.
 *
 * Each file the install writes is written by a command inside the sandbox:
 * the host never writes into a tree after the commit's files are in it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ColdCacheRefused, installApp, type OutsideInstall } from '../app-install.ts';
import type { EgressNamespace } from '../namespace.ts';
import type { RunDirs } from '../scratch.ts';
import type { Checkout } from './app-paths.ts';
import { studioEnvironment } from './app-start.ts';
import { mustRun, type Runner } from './exec.ts';
import { readRunFile } from './host-files.ts';
import { lockfileProblems } from './lockfile.ts';

const STEP_TIMEOUT_MS = 2 * 60_000;
const ROOT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const ENV_KEYS = /^(NEXT_PUBLIC_FIREBASE_|FIREBASE_)/;
const UI_RULES = fileURLToPath(new URL('./ui-rules', import.meta.url));
const MISSING_PACKAGE = /(?:request to \S*?registry\.npmjs\.org\/(\S+?) failed|ENOTCACHED[^\n]*?\/([@\w./-]+))/;

export class InstallFailed extends Error {}

/** The host's bun cache, which a sandboxed root install reads under an overlay. */
export function bunCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), '.bun', 'install', 'cache');
}

/** `.env.local` lines: the fake web config only, no provider key. */
export function envLocal(checkout: Checkout): string {
  const env = studioEnvironment({ checkout });
  const lines = Object.entries(env).filter(([key]) => ENV_KEYS.test(key)).map(([key, value]) => `${key}=${value}`);
  return `# Written by the pyric factory: a demo- project and a fake key. No provider keys.\n${lines.join('\n')}\n`;
}

function runDirsOf(checkout: Checkout, app: string): RunDirs {
  return { root: checkout.root, app, home: checkout.home, logs: checkout.logs, networkLog: checkout.networkLog, netLog: join(checkout.logs, 'chromium-netlog.json') };
}

/** The package a cold-cache install lacked, from npm's log. */
export function missingPackage(log: string): string | undefined {
  const match = MISSING_PACKAGE.exec(log);
  return match?.[1] ?? match?.[2];
}

async function installNpm(input: InstallInput, app: string, label: string): Promise<void> {
  const { namespace, checkout, say } = input;
  try {
    await installApp(namespace, runDirsOf(checkout, app), label, say, input.outsideInstall ?? 'forbidden');
  } catch (error) {
    if (!(error instanceof ColdCacheRefused)) throw error;
    const log = readRunFile(join(checkout.logs, '00-npm-install-sandbox.log'));
    const name = log.ok ? missingPackage(log.text) : undefined;
    throw new InstallFailed(`${label}: the shared npm cache lacks ${name ?? 'a package'}; run factory-setup's install to warm it`);
  }
}

/** Writes `text` to `file` from inside the sandbox. */
async function writeInside(runner: Runner, file: string, text: string, cwd: string): Promise<void> {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)})`;
  await mustRun(runner, { command: 'node', args: ['-e', script], cwd, timeoutMs: STEP_TIMEOUT_MS }, `writing ${file}`);
}

/** Copies the factory's UI rules and their util into Studio's checks, inside the sandbox. */
async function copyRules(runner: Runner, checkout: Checkout): Promise<void> {
  const script = 'mkdir -p checks/factory-rules checks/factory-utils && cp "$1"/rules/*.yml checks/factory-rules/ && cp "$1"/utils/*.yml checks/factory-utils/';
  await mustRun(runner, { command: '/bin/sh', args: ['-c', script, 'sh', UI_RULES], cwd: checkout.studio, timeoutMs: STEP_TIMEOUT_MS }, 'copying the UI rules');
}

async function installRoot(runner: Runner, checkout: Checkout): Promise<void> {
  const lock = readRunFile(join(checkout.repo, 'bun.lock'));
  if (!lock.ok) throw new InstallFailed(`the repo's bun.lock can't be read: ${lock.problem}`);
  const problems = lockfileProblems(lock.text);
  if (problems.length > 0) throw new InstallFailed(`bun.lock names sources other than the npm registry:\n- ${problems.join('\n- ')}`);
  const args = ['install', '--frozen-lockfile', '--ignore-scripts', '--backend=copyfile'];
  const env = { BUN_INSTALL_CACHE_DIR: bunCacheDir() };
  await mustRun(runner, { command: 'bun', args, cwd: checkout.repo, timeoutMs: ROOT_INSTALL_TIMEOUT_MS, env }, 'bun install at the repo root, inside the sandbox');
}

export interface InstallInput {
  runner: Runner;
  namespace: EgressNamespace;
  checkout: Checkout;
  withRoot: boolean;
  /** Only setup's install of the start commit may fall back to the host on a cold cache. */
  outsideInstall?: OutsideInstall;
  say: (line: string) => void;
}

export async function installStudio(input: InstallInput): Promise<void> {
  const { runner, checkout } = input;
  await writeInside(runner, '.env.local', envLocal(checkout), checkout.studio);
  await copyRules(runner, checkout);
  if (input.withRoot) await installRoot(runner, checkout);
  await installNpm(input, checkout.studio, 'studio');
  await mustRun(runner, { command: 'node', args: ['scripts/patch-pyric-bridge-port.js'], cwd: checkout.studio, timeoutMs: STEP_TIMEOUT_MS }, 'Studio\'s postinstall patch');
  const functions = join(checkout.repo, 'functions');
  const hasFunctions = readRunFile(join(functions, 'package.json')).ok;
  if (!hasFunctions) return;
  await installNpm(input, functions, 'functions');
  await mustRun(runner, { command: 'node', args: ['node_modules/typescript/bin/tsc'], cwd: functions, timeoutMs: STEP_TIMEOUT_MS }, 'building the functions source');
}
