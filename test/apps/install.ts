/**
 * Installs an app the way a user does: the app's own package.json, `npm
 * install`, real registry packages for everything that is not Pyric. The
 * Pyric packages come from packed tarballs, never from workspace sources.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeUnreapedExit, watchUnreapedExit } from './unreaped-exit.ts';

/** The published packages, in the order scripts/pack-packages.sh packs them. */
const PUBLISHED_PACKAGE_DIRS = [
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
];

/** Files in an app directory that drive it and are not part of the app. */
const DRIVER_FILES = new Set(['scenario.ts', 'README.md', 'node_modules', '.pyric']);

export type Tarballs = Map<string, string>;

function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

/** The tarball of each published package in `dir`, named as `npm pack` names them. */
export function tarballsIn(root: string, dir: string): Tarballs {
  const tarballs: Tarballs = new Map();
  for (const packageDir of PUBLISHED_PACKAGE_DIRS) {
    const manifest = JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const file = resolve(dir, tarballName(manifest.name, manifest.version));
    if (!existsSync(file)) throw new Error(`missing packed package ${manifest.name}: ${file}`);
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

export interface CommandResult {
  code: number | null;
  output: string;
}

/**
 * Runs a command to exit. A child whose exit the runner never sees (#1274)
 * resolves from the exit code /proc keeps for it.
 */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const spawnChild = options.spawnChild ?? spawn;
    const child = spawnChild(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    const stopWatching = child.pid === undefined ? () => {} : watchUnreapedExit(child.pid, (exit) => {
      output += describeUnreapedExit(command, exit);
      resolvePromise({ code: exit.code, output });
    });
    child.on('error', (error) => {
      stopWatching();
      reject(error);
    });
    child.on('close', (code) => {
      stopWatching();
      resolvePromise({ code, output });
    });
  });
}

/** Packs the published packages into dist/packages and returns their tarballs. */
export async function packWorkspace(root: string, build: boolean): Promise<Tarballs> {
  const args = ['scripts/pack-packages.sh', ...(build ? [] : ['--skip-build'])];
  const result = await runCommand('bash', args, { cwd: root });
  if (result.code !== 0) throw new Error(`packing failed (exit ${result.code}):\n${result.output}`);
  return tarballsIn(root, join(root, 'dist/packages'));
}

/**
 * Copies the app into `projectDir` and points its Pyric dependencies at the
 * tarballs. The overrides pin every Pyric package to its tarball, so the
 * packages' dependencies on each other resolve locally too. `npm install`
 * runs next, through `SharedInstalls`.
 */
export function prepareApp(options: { appDir: string; projectDir: string; tarballs: Tarballs }): void {
  for (const entry of readdirSync(options.appDir)) {
    if (DRIVER_FILES.has(entry)) continue;
    cpSync(join(options.appDir, entry), join(options.projectDir, entry), { recursive: true });
  }
  pinPyricPackages(options.projectDir, options.tarballs);
}

/**
 * Points the Pyric dependencies in `projectDir/package.json` at the tarballs
 * and pins every Pyric package to its tarball through `overrides`. Also used
 * for a project a scenario creates, such as one `create-pyric` scaffolds.
 */
export function pinPyricPackages(projectDir: string, tarballs: Tarballs): void {
  const manifestPath = join(projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const pins = Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`]));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (pins[name]) dependencies[name] = pins[name];
    }
  }
  manifest.overrides = { ...(manifest.overrides as object | undefined), ...pins };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * `npm install` as the runner runs it: quiet, with the shared cache. Offline
 * first by default; `online` revalidates the cached package listings.
 */
export function npmInstallArgs(npmCache: string, metadata: 'offline' | 'online' = 'offline'): string[] {
  return ['install', '--no-audit', '--no-fund', '--loglevel=error', `--prefer-${metadata}`, '--cache', npmCache];
}

/** npm's codes for a version range the cached package listing has no match for. */
const STALE_METADATA = /\bcode (ETARGET|ENOVERSIONS)\b/;

/**
 * Whether a failed install is explained by stale cached metadata. With
 * `--prefer-offline`, npm trusts a cached package listing, so a dependency
 * that asks for a version published after the listing was cached fails with
 * ETARGET (#1246). The version exists; the listing is old.
 */
export function shouldRetryOnline(result: CommandResult): boolean {
  const isFailure = result.code !== 0;
  return isFailure && STALE_METADATA.test(result.output);
}

/** Run `npm install` offline first, and once more with `--prefer-online` when stale metadata failed it. */
export async function npmInstall(npmCache: string, run: (args: string[]) => Promise<CommandResult>): Promise<CommandResult> {
  const first = await run(npmInstallArgs(npmCache));
  if (!shouldRetryOnline(first)) return first;
  const note = '\n[runner] npm install failed on stale cached metadata; retrying once with --prefer-online\n';
  const second = await run(npmInstallArgs(npmCache, 'online'));
  return { code: second.code, output: `${first.output}${note}${second.output}` };
}
