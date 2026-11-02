/**
 * Installs Studio in a checkout: npm inside the sandbox from the warm shared
 * cache, as a round's apps install (`app-install.ts`), falling back to the
 * host under the recorder when the cache is cold; then Studio's own
 * postinstall patch, which `--ignore-scripts` skipped. `ffmpeg-static`'s
 * download is skipped with it; `ffmpeg.ts` puts the binary in place. With
 * `withRoot`, the repo root's packages too, for Studio's tests.
 *
 * `pyric sandbox` refuses to start when firebase.json declares a Functions
 * source whose entry is missing, and Studio's (`../functions`, auth blocking
 * triggers) is build output no clone has; so the functions package is
 * installed and built the same way.
 *
 * Writes `studio/.env.local` with the placeholder web config `app-start.ts`
 * passes, so a role that runs `npm run dev` itself gets the same values.
 *
 * Skips everything when the manifests match the last install's.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installApp } from '../app-install.ts';
import type { RunDirs } from '../scratch.ts';
import type { AppPaths, Checkout } from './app-paths.ts';
import { studioEnvironment } from './app-start.ts';
import { hostRunner, mustRun, type Runner } from './exec.ts';
import { placeFfmpeg } from './ffmpeg.ts';
import type { SandboxOpener } from './sandbox.ts';

export type { SandboxOpener } from './sandbox.ts';

const PATCH_TIMEOUT_MS = 60_000;
const ROOT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const ENV_KEYS = /^(NEXT_PUBLIC_FIREBASE_|FIREBASE_)/;

export interface InstallOptions {
  openSandbox: SandboxOpener;
  withRoot: boolean;
  say: (line: string) => void;
}

function manifestFiles(checkout: Checkout, withRoot: boolean): string[] {
  const studio = [join(checkout.studio, 'package.json'), join(functionsDir(checkout), 'package.json')];
  const root = [join(checkout.repo, 'package.json'), join(checkout.repo, 'bun.lock')];
  return withRoot ? [...studio, ...root] : studio;
}

function manifestHash(files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(existsSync(file) ? readFileSync(file) : '');
  return hash.digest('hex');
}

function markerPath(checkout: Checkout): string {
  return join(checkout.logs, 'installed.json');
}

function isInstalled(checkout: Checkout, hash: string): boolean {
  const marker = markerPath(checkout);
  return existsSync(marker) && (JSON.parse(readFileSync(marker, 'utf8')) as { hash?: string }).hash === hash;
}

/** `.env.local` lines: the fake web config only, no provider key. */
export function envLocal(checkout: Checkout): string {
  const env = studioEnvironment({ checkout });
  const lines = Object.entries(env).filter(([key]) => ENV_KEYS.test(key)).map(([key, value]) => `${key}=${value}`);
  return `# Written by the pyric factory: a demo- project and a fake key. No provider keys.\n${lines.join('\n')}\n`;
}

function functionsDir(checkout: Checkout): string {
  return join(checkout.repo, 'functions');
}

function runDirsOf(checkout: Checkout, app: string): RunDirs {
  return { root: checkout.root, app, home: checkout.home, logs: checkout.logs, networkLog: checkout.networkLog, netLog: join(checkout.logs, 'chromium-netlog.json') };
}

/** The host's bun cache, so the root install reads what earlier installs fetched. */
function bunEnvironment(): Record<string, string> {
  return { BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), '.bun', 'install', 'cache') };
}

/** Installs the repo root's dependencies on the host: the registry is outside the sandbox. */
export async function installRoot(checkout: Checkout, runner: Runner = hostRunner(checkout.home)): Promise<void> {
  mkdirSync(checkout.home, { recursive: true });
  const args = ['install', '--frozen-lockfile', '--ignore-scripts'];
  await mustRun(runner, { command: 'bun', args, cwd: checkout.repo, timeoutMs: ROOT_INSTALL_TIMEOUT_MS, env: bunEnvironment() }, 'bun install at the repo root');
}

export async function installStudio(paths: AppPaths, checkout: Checkout, options: InstallOptions): Promise<void> {
  mkdirSync(checkout.logs, { recursive: true });
  writeFileSync(join(checkout.studio, '.env.local'), envLocal(checkout));
  const hash = manifestHash(manifestFiles(checkout, options.withRoot));
  if (isInstalled(checkout, hash)) {
    placeFfmpeg(paths, checkout);
    return;
  }
  if (options.withRoot) {
    await installRoot(checkout);
    placeFfmpeg(paths, checkout);
  }
  await options.openSandbox(checkout.root, paths, async (runner, namespace) => {
    await installApp(namespace, runDirsOf(checkout, checkout.studio), 'studio', options.say);
    const patch = { command: 'node', args: ['scripts/patch-pyric-bridge-port.js'], cwd: checkout.studio, timeoutMs: PATCH_TIMEOUT_MS };
    await mustRun(runner, patch, 'Studio\'s postinstall patch');
    const functions = functionsDir(checkout);
    if (!existsSync(join(functions, 'package.json'))) return;
    await installApp(namespace, runDirsOf(checkout, functions), 'functions', options.say);
    const build = { command: 'node', args: ['node_modules/typescript/bin/tsc'], cwd: functions, timeoutMs: PATCH_TIMEOUT_MS };
    await mustRun(runner, build, 'building the functions source');
  });
  writeFileSync(markerPath(checkout), `${JSON.stringify({ hash, at: new Date().toISOString() })}\n`);
}
