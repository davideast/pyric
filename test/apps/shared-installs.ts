/**
 * One `npm install` per dependency set per run. Most apps install the same
 * packages (24 of 31 share two sets), so the runner installs each set once,
 * in a directory of its own, and copies the installed `node_modules` into
 * every app that uses it. Each set is still a real `npm install` of the packed
 * tarballs and the registry packages the app's package.json names.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CommandResult } from './install.ts';

/** The package.json fields that decide what `npm install` puts in node_modules. */
const INSTALL_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'] as const;

/** Root scripts npm runs in the project directory during `npm install`. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'dependencies'];

/** Lockfiles that pin what an app installs; an app that ships one installs from it, alone. */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

/**
 * A spec that shares: a registry range, a tag, a URL, or an absolute path to
 * a tarball, like the `file:` pins pinPyricPackages writes. Any other path
 * (`./x`, `../x`, `~/x`, `file:x`, a `file:` or `link:` directory) points at
 * a directory relative to the app or outside the tarballs, so it installs alone.
 */
const PATH_SPEC = /^(file:|link:|\.{1,2}\/|~\/|\/)/;
const ABSOLUTE_TARBALL = /^file:\/.*\.(tgz|tar\.gz)$/;

function isLocalSpec(spec: string): boolean {
  return PATH_SPEC.test(spec) && !ABSOLUTE_TARBALL.test(spec);
}

/** Every string value in a dependency field, at any depth (overrides nest). */
function specsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  const isObject = typeof value === 'object' && value !== null;
  return isObject ? Object.values(value).flatMap(specsIn) : [];
}

interface Manifest {
  scripts?: Record<string, string>;
  workspaces?: unknown;
  [field: string]: unknown;
}

function sortedObject(value: unknown): unknown {
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isPlainObject) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortedObject(entry)]));
}

/** The fields of a manifest that a shared install writes, in a stable order. */
function installManifest(manifest: Manifest): Record<string, unknown> {
  return Object.fromEntries(INSTALL_FIELDS.filter((field) => manifest[field] !== undefined).map((field) => [field, sortedObject(manifest[field])]));
}

/** The files of a prepared app that decide its install. */
export interface InstallInputs {
  manifest: string;
  npmrc?: string;
  /** Whether the app ships a package-lock.json or npm-shrinkwrap.json. */
  lockfile?: boolean;
}

/**
 * The key two apps share when one install serves both, or undefined when the
 * app must install in its own directory: it ships a lockfile, its install
 * runs its own scripts, or it depends on a path (workspaces, `./server`).
 */
export function dependencySetKey(inputs: InstallInputs): string | undefined {
  const manifest = JSON.parse(inputs.manifest) as Manifest;
  const runsInstallScripts = INSTALL_SCRIPTS.some((script) => manifest.scripts?.[script] !== undefined);
  const dependsOnPath = INSTALL_FIELDS.flatMap((field) => specsIn(manifest[field])).some(isLocalSpec);
  const installsAlone = inputs.lockfile === true || runsInstallScripts || manifest.workspaces !== undefined || dependsOnPath;
  if (installsAlone) return undefined;
  const identity = JSON.stringify({ manifest: installManifest(manifest), npmrc: inputs.npmrc ?? null });
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/**
 * Copy an installed `node_modules` into an app, symlinks as symlinks, in a
 * worker thread (copy-tree-worker.ts) so the apps already running keep their
 * timers and sockets moving while it copies.
 *
 * A copy, not hard links: with hard links, every full run here had an app
 * whose server process stalled or never closed, and with copies runs passed.
 * Each app also gets files it can change without changing every other app's.
 * Not a `cp` child process either: under Bun, a burst of children exiting
 * together, as when several apps get their set's install at once, left
 * exited children unreaped, and the runner waited on one forever.
 */
export function copyTree(from: string, to: string): Promise<void> {
  mkdirSync(dirname(to), { recursive: true });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./copy-tree-worker.ts', import.meta.url), { workerData: { from, to } });
    worker.once('message', (result: { ok: boolean; message?: string }) => {
      void worker.terminate();
      if (result.ok) resolve();
      else reject(new Error(`copying ${from} to ${to} failed: ${result.message ?? 'unknown error'}`));
    });
    worker.once('error', reject);
  });
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function readInstallInputs(projectDir: string): InstallInputs {
  return {
    manifest: readFileSync(join(projectDir, 'package.json'), 'utf8'),
    npmrc: readOptional(join(projectDir, '.npmrc')),
    lockfile: LOCKFILES.some((file) => existsSync(join(projectDir, file))),
  };
}

/** Runs `npm install` in a directory. */
export type InstallIn = (cwd: string) => Promise<CommandResult>;

interface SetInstall {
  dir: string;
  result: Promise<CommandResult>;
}

/** The installs of one run, one per dependency set, made in directories under `baseDir`. */
export class SharedInstalls {
  private readonly sets = new Map<string, SetInstall>();

  constructor(private readonly baseDir: string, private readonly installIn: InstallIn) {}

  /**
   * Install the app prepared in `projectDir`: its set's install, linked in,
   * or its own when it installs alone. When the set's install fails, the app
   * installs on its own, so one failed attempt (a dropped connection, say)
   * costs each app what it cost before sets were shared.
   */
  async install(projectDir: string): Promise<CommandResult> {
    const inputs = readInstallInputs(projectDir);
    const key = dependencySetKey(inputs);
    if (key === undefined) return this.installIn(projectDir);
    const existing = this.sets.get(key);
    const set = existing ?? this.startSet(key, inputs);
    const shared = await set.result;
    const made = existing === undefined ? 'made for this app' : 'made for an earlier app in this run';
    const header = `[runner] shared install ${key}, ${made}\n`;
    if (shared.code !== 0) {
      const own = await this.installIn(projectDir);
      const note = '\n[runner] the shared install failed; installing this app on its own\n';
      return { code: own.code, output: `${header}${shared.output}${note}${own.output}` };
    }
    await copyTree(join(set.dir, 'node_modules'), join(projectDir, 'node_modules'));
    const lockfile = join(set.dir, 'package-lock.json');
    if (existsSync(lockfile)) await copyFile(lockfile, join(projectDir, 'package-lock.json'));
    return { code: 0, output: `${header}${shared.output}` };
  }

  private startSet(key: string, inputs: InstallInputs): SetInstall {
    const dir = join(this.baseDir, key);
    mkdirSync(dir, { recursive: true });
    const manifest = { private: true, ...installManifest(JSON.parse(inputs.manifest) as Manifest) };
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (inputs.npmrc !== undefined) writeFileSync(join(dir, '.npmrc'), inputs.npmrc);
    const set = { dir, result: this.installIn(dir) };
    this.sets.set(key, set);
    return set;
  }
}
