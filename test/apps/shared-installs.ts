/**
 * One `npm install` per dependency set per run. Most apps install the same
 * packages (24 of 31 share two sets), so the runner installs each set once,
 * in a directory of its own, and hard-links the installed `node_modules` into
 * every app that uses it. Each set is still a real `npm install` of the packed
 * tarballs and the registry packages the app's package.json names.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult } from './install.ts';

/** The package.json fields that decide what `npm install` puts in node_modules. */
const INSTALL_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'] as const;

/** Scripts npm runs in the project directory during an install. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * A dependency spec with a relative path, which points into the app's own
 * directory. The absolute `file:` paths pinPyricPackages writes for the
 * tarballs are the same from any directory, so they share.
 */
const LOCAL_SPEC = /^(file|link):(?!\/)/;

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

function linksOwnDirectory(manifest: Manifest): boolean {
  const specs = INSTALL_FIELDS.flatMap((field) => Object.values((manifest[field] as Record<string, unknown> | undefined) ?? {}));
  return specs.some((spec) => typeof spec === 'string' && LOCAL_SPEC.test(spec));
}

/** The fields of a manifest that a shared install writes, in a stable order. */
function installManifest(manifest: Manifest): Record<string, unknown> {
  return Object.fromEntries(INSTALL_FIELDS.filter((field) => manifest[field] !== undefined).map((field) => [field, sortedObject(manifest[field])]));
}

/**
 * The key two apps share when one install serves both, or undefined when the
 * app must install in its own directory: its install runs its own scripts, or
 * it links directories of its own (workspaces, `file:./...`).
 */
export function dependencySetKey(manifestText: string, npmrc: string | undefined): string | undefined {
  const manifest = JSON.parse(manifestText) as Manifest;
  const runsInstallScripts = INSTALL_SCRIPTS.some((script) => manifest.scripts?.[script] !== undefined);
  const installsAlone = runsInstallScripts || manifest.workspaces !== undefined || linksOwnDirectory(manifest);
  if (installsAlone) return undefined;
  const identity = JSON.stringify({ manifest: installManifest(manifest), npmrc: npmrc ?? null });
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** Recreate `from` at `to`: directories are made, files hard-linked, symlinks copied as symlinks. */
export function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) linkTree(source, target);
    else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else linkFile(source, target);
  }
}

function linkFile(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch (error) {
    // A hard link cannot cross filesystems; copy instead.
    const isCrossDevice = (error as NodeJS.ErrnoException).code === 'EXDEV';
    if (!isCrossDevice) throw error;
    copyFileSync(source, target);
  }
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
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

  /** Install the app prepared in `projectDir`: its set's install, linked in, or its own when it installs alone. */
  async install(projectDir: string): Promise<CommandResult> {
    const manifestText = readFileSync(join(projectDir, 'package.json'), 'utf8');
    const npmrc = readOptional(join(projectDir, '.npmrc'));
    const key = dependencySetKey(manifestText, npmrc);
    if (key === undefined) return this.installIn(projectDir);
    const existing = this.sets.get(key);
    const set = existing ?? this.startSet(key, manifestText, npmrc);
    const result = await set.result;
    const header = existing === undefined
      ? `[runner] shared install ${key}, made for this app\n`
      : `[runner] shared install ${key}, made for an earlier app in this run\n`;
    if (result.code !== 0) return { code: result.code, output: `${header}${result.output}` };
    linkTree(join(set.dir, 'node_modules'), join(projectDir, 'node_modules'));
    const lockfile = join(set.dir, 'package-lock.json');
    if (existsSync(lockfile)) copyFileSync(lockfile, join(projectDir, 'package-lock.json'));
    return { code: 0, output: `${header}${result.output}` };
  }

  private startSet(key: string, manifestText: string, npmrc: string | undefined): SetInstall {
    const dir = join(this.baseDir, key);
    mkdirSync(dir, { recursive: true });
    const manifest = { private: true, ...installManifest(JSON.parse(manifestText) as Manifest) };
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (npmrc !== undefined) writeFileSync(join(dir, '.npmrc'), npmrc);
    const set = { dir, result: this.installIn(dir) };
    this.sets.set(key, set);
    return set;
  }
}
