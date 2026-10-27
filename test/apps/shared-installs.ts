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
import { basename, dirname, join } from 'node:path';
import type { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { CommandResult } from './install.ts';

/**
 * The package.json fields the shared install copies and keys on: what the app
 * depends on. The project's name is keyed too (see `InstallInputs.name`).
 */
const INSTALL_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'] as const;

/**
 * Root fields that also change what `npm install` does, and that a shared
 * install does not carry over; an app that has one installs alone.
 */
const SOLO_FIELDS = ['peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'engines', 'os', 'cpu', 'workspaces'] as const;

/** Root scripts npm runs in the project directory during `npm install`. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish', 'dependencies'];

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
  /**
   * The project's name as npm writes it into package-lock.json: package.json's
   * `name`, or the directory's name when it has none. The shared install is
   * made under this name, so the lockfile copied into the app is the one the
   * app's own install would have written.
   */
  name: string;
  npmrc?: string;
  /** Whether the app ships a package-lock.json or npm-shrinkwrap.json. */
  lockfile?: boolean;
  /** Whether the app has a binding.gyp, which makes npm run node-gyp in it. */
  bindingGyp?: boolean;
}

/**
 * The key two apps share when one install serves both, or undefined when the
 * app must install in its own directory: it ships a lockfile, its install
 * runs its own scripts (or node-gyp), it has a root field the shared install
 * does not carry, or it depends on a path (`./server`).
 */
export function dependencySetKey(inputs: InstallInputs): string | undefined {
  const manifest = JSON.parse(inputs.manifest) as Manifest;
  const runsInstallScripts = inputs.bindingGyp === true || INSTALL_SCRIPTS.some((script) => manifest.scripts?.[script] !== undefined);
  const hasSoloField = SOLO_FIELDS.some((field) => manifest[field] !== undefined);
  const dependsOnPath = INSTALL_FIELDS.flatMap((field) => specsIn(manifest[field])).some(isLocalSpec);
  const installsAlone = inputs.lockfile === true || runsInstallScripts || hasSoloField || dependsOnPath;
  if (installsAlone) return undefined;
  const identity = JSON.stringify({ name: inputs.name, manifest: installManifest(manifest), npmrc: inputs.npmrc ?? null });
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** What `copyTree` needs of its worker: the events a Worker emits, and a way to end it. */
export type CopyWorker = Pick<EventEmitter, 'once'> & { terminate(): unknown };

export type StartCopyWorker = (from: string, to: string) => CopyWorker;

/** How long a copy worker's result may trail its clean exit before the copy counts as failed. */
const RESULT_AFTER_EXIT_MS = 1000;

const startCopyTreeWorker: StartCopyWorker = (from, to) => new Worker(new URL('./copy-tree-worker.ts', import.meta.url), { workerData: { from, to } });

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
export function copyTree(from: string, to: string, startWorker: StartCopyWorker = startCopyTreeWorker): Promise<void> {
  mkdirSync(dirname(to), { recursive: true });
  return new Promise((resolve, reject) => {
    const worker = startWorker(from, to);
    let answered = false;
    worker.once('message', (result: { ok: boolean; message?: string }) => {
      answered = true;
      void worker.terminate();
      if (result.ok) resolve();
      else reject(new Error(`copying ${from} to ${to} failed: ${result.message ?? 'unknown error'}`));
    });
    worker.once('error', reject);
    // A worker killed before it answers (out of memory, say) settles the copy too.
    const failUnanswered = (code: number) => {
      if (!answered) reject(new Error(`copying ${from} to ${to} failed: the copy worker exited with code ${code} before it finished`));
    };
    // A clean exit can be handled before the result it posted (#1280), so it waits for that result first.
    worker.once('exit', (code: number) => {
      const isClean = code === 0;
      if (isClean) setTimeout(() => failUnanswered(code), RESULT_AFTER_EXIT_MS);
      else failUnanswered(code);
    });
  });
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function readInstallInputs(projectDir: string): InstallInputs {
  const manifest = readFileSync(join(projectDir, 'package.json'), 'utf8');
  const declaredName = (JSON.parse(manifest) as { name?: unknown }).name;
  return {
    manifest,
    name: typeof declaredName === 'string' ? declaredName : basename(projectDir),
    npmrc: readOptional(join(projectDir, '.npmrc')),
    lockfile: LOCKFILES.some((file) => existsSync(join(projectDir, file))),
    bindingGyp: existsSync(join(projectDir, 'binding.gyp')),
  };
}

/** How many times a set's install is tried before every app that shares it fails with its log. */
const SET_INSTALL_ATTEMPTS = 2;

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
   * Install the app prepared in `projectDir`: its set's install, copied in,
   * or its own when it installs alone. A set's install is tried twice, so one
   * dropped connection does not fail the set; when both attempts fail, every
   * app that shares it fails with that log, without installing again.
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
    if (shared.code !== 0) return { code: shared.code, output: `${header}${shared.output}` };
    try {
      await copyTree(join(set.dir, 'node_modules'), join(projectDir, 'node_modules'));
      const lockfile = join(set.dir, 'package-lock.json');
      if (existsSync(lockfile)) await copyFile(lockfile, join(projectDir, 'package-lock.json'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { code: 1, output: `${header}${shared.output}\n[runner] ${message}\n` };
    }
    return { code: 0, output: `${header}${shared.output}` };
  }

  private async installSet(dir: string): Promise<CommandResult> {
    let output = '';
    for (let attempt = 1; attempt <= SET_INSTALL_ATTEMPTS; attempt++) {
      const result = await this.installIn(dir);
      output += result.output;
      if (result.code === 0) return { code: 0, output };
      const isLastAttempt = attempt === SET_INSTALL_ATTEMPTS;
      if (isLastAttempt) return { code: result.code, output };
      output += `\n[runner] the shared install failed (exit ${result.code}); trying it once more\n`;
    }
    return { code: 1, output };
  }

  private startSet(key: string, inputs: InstallInputs): SetInstall {
    const dir = join(this.baseDir, key);
    mkdirSync(dir, { recursive: true });
    const manifest = { name: inputs.name, private: true, ...installManifest(JSON.parse(inputs.manifest) as Manifest) };
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (inputs.npmrc !== undefined) writeFileSync(join(dir, '.npmrc'), inputs.npmrc);
    const set = { dir, result: this.installSet(dir) };
    this.sets.set(key, set);
    return set;
  }
}
