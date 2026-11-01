/**
 * Installs a run's app: `npm install --ignore-scripts --offline` inside the
 * run's sandbox, from the warm shared cache (read-only, under an overlay
 * whose writes stay in the sandbox), under the Node recorder. Only when the
 * cache is cold for the app does it install outside the sandbox, still with
 * `--ignore-scripts` and under the recorder, which refuses any Google host;
 * the kernel does not block that one. The canary and every builder run
 * install this way, with `test/apps/install.ts`'s own functions.
 *
 * `reproduce` installs an app the builder wrote, whose package.json can name
 * any dependency or source. It forbids the fallback, so a cold cache ends
 * the try and nothing of that app installs outside the sandbox.
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { AppRun } from '../apps/driver.ts';
import { npmInstall, npmOfflineInstallArgs, type CommandResult } from '../apps/install.ts';
import type { EgressNamespace } from './namespace.ts';
import { recorderEnvironment, type RunDirs } from './scratch.ts';

const INSTALL_TIMEOUT_MS = 300_000;
/** The registry the shared cache was warmed from; an offline install reads its cached listings under this URL. */
const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** What npm says when an offline install needs something the cache doesn't hold. */
const COLD_CACHE = /\bENOTCACHED\b/;
/** No package's install scripts run, inside the sandbox or out. */
const IGNORE_SCRIPTS = '--ignore-scripts';

export function npmCacheDir(): string {
  return process.env.PYRIC_APPS_NPM_CACHE ?? join(homedir(), '.cache', 'pyric-app-scenarios-npm');
}

/** Whether an offline install failed only because the cache lacks something the app needs. */
export function isColdCache(result: CommandResult): boolean {
  return result.code !== 0 && COLD_CACHE.test(result.output);
}

/** The harness drives Chromium through its own browser server, never AppRun's. */
export const noDriverBrowser = (): Promise<Browser> => Promise.reject(new Error('builder runs use the harness browser server'));

/** Whether an install may fall back to the host when the cache is cold. */
export type OutsideInstall = 'allowed' | 'forbidden';

/** A cold cache where installing outside the sandbox is forbidden. */
export class ColdCacheRefused extends Error {}

/** What follows the install inside the sandbox. */
export type InstallNext = 'done' | 'install-outside' | 'refuse-cold-cache' | 'fail';

export function nextAfterSandboxInstall(inside: CommandResult, outside: OutsideInstall): InstallNext {
  if (inside.code === 0) return 'done';
  if (!isColdCache(inside)) return 'fail';
  return outside === 'allowed' ? 'install-outside' : 'refuse-cold-cache';
}

/**
 * Installs `dirs.app`; `say` prints each step. With `outsideInstall: 'forbidden'`
 * a cold cache throws `ColdCacheRefused` instead of installing on the host.
 */
export async function installApp(
  namespace: EgressNamespace,
  dirs: RunDirs,
  label: string,
  say: (line: string) => void,
  outsideInstall: OutsideInstall = 'allowed',
): Promise<void> {
  say('npm install --ignore-scripts --offline, from the warm cache, inside the sandbox');
  const app = new AppRun(`${label} install`, dirs.app, dirs.home, noDriverBrowser);
  const npmCache = npmCacheDir();
  const recorded = recorderEnvironment(dirs.networkLog);
  const run = (command: string, args: string[]) => app.command(command, args, { env: recorded, timeoutMs: INSTALL_TIMEOUT_MS });
  try {
    const offlineArgs = [...npmOfflineInstallArgs(npmCache, NPM_REGISTRY), IGNORE_SCRIPTS, `--logs-dir=${dirs.logs}`];
    const entered = namespace.enter('npm', offlineArgs, dirs.app);
    const inside = await run(entered.command, entered.args);
    writeFileSync(join(dirs.logs, '00-npm-install-sandbox.log'), inside.output);
    const next = nextAfterSandboxInstall(inside, outsideInstall);
    if (next === 'done') return;
    if (next === 'fail') throw new Error(`npm install inside the sandbox failed (exit ${inside.code}):\n${inside.output}`);
    if (next === 'refuse-cold-cache') throw new ColdCacheRefused('the npm cache lacks a package this app needs, and installing outside the sandbox is forbidden');
    say('the npm cache is cold for this app: npm install --ignore-scripts outside the sandbox, under the recorder');
    const outside = await npmInstall(npmCache, (args) => run('npm', [...args, IGNORE_SCRIPTS]));
    writeFileSync(join(dirs.logs, '00-npm-install-outside.log'), outside.output);
    if (outside.code !== 0) throw new Error(`npm install failed (exit ${outside.code}):\n${outside.output}`);
  } finally {
    await app.close();
  }
}
