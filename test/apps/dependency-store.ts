/**
 * A store of installed `node_modules` trees, one entry per third-party
 * dependency set, shared by every run and worktree on the machine (#1514).
 *
 * Only the packed Pyric tarballs change from one run to the next, so an entry
 * is keyed by everything else that decides its packages. Warming an entry is
 * the only step that reaches the registry: an online `npm install` of the set,
 * the way the runner always installed it. A run then copies the entry's tree
 * into the set's directory, restamps the lockfile's Pyric entries from this
 * run's tarballs, removes the files of each copied Pyric package that is not
 * this run's, and runs `npm install --offline` with an empty npm cache and a
 * registry nothing listens on, so npm installs the new tarballs and cannot
 * fetch anything else.
 * Third-party install scripts ran once, when the entry was warmed. Every
 * third-party lockfile entry must come out of that install unchanged, and
 * every Pyric package must hold exactly its tarball's files, or the set fails.
 *
 * Layout: `<store>/<key>/` holds `package.json`, `package-lock.json`,
 * `node_modules` and `store.json` (the key's inputs, for debugging). An entry
 * is built in `<store>/.warm-<key>-*` and renamed into place, so two runs
 * warming one key leave one complete entry.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { removeTree } from './cleanup.ts';
import { debugLogTail, npmInstall, npmOfflineInstallArgs, pinPyricPackages, runCommand, type CommandResult, type Tarballs, type TimedResult } from './install.ts';
import type { NestedProject } from './nested-projects.ts';
import { installedFileProblems, tarFiles } from './packed-files.ts';
import { copyTree, installManifest, sortedObject, type Manifest, type SetInstallResult } from './shared-installs.ts';

/** Bumped when the layout or the key's inputs change, so old entries are never read. */
export const STORE_FORMAT = 1;

/** What a Pyric package's spec becomes in the key, so the tarball's path and version drop out. */
const PYRIC_SPEC = '<pyric tarball>';

/**
 * The fields of a published package that decide what an install of it puts
 * in the tree. Its dependencies on other Pyric packages count too, by name.
 */
const PUBLISHED_INSTALL_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies'] as const;

/** The published fields whose values are version specs, where a Pyric package's spec becomes the placeholder. */
const PUBLISHED_SPEC_FIELDS = new Set<string>(['dependencies', 'optionalDependencies', 'peerDependencies']);

/** The root lockfile fields that carry the project's own dependency specs. */
const ROOT_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** Lockfile fields npm copies from a package's manifest. */
const MANIFEST_LOCK_FIELDS = ['license', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'funding'] as const;

/** Lockfile fields that say where a package sits in the tree, not what it is. */
const PLACEMENT_FIELDS = ['dev', 'optional', 'devOptional', 'peer', 'inBundle', 'extraneous'] as const;

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/** How long one attempt to warm an entry from the registry gets. */
export const WARM_ATTEMPT_MS = 300_000;

/** How long the offline install of a run's tarballs into a copied tree gets. */
export const MATERIALIZE_MS = 60_000;

/** A port nothing listens on: a request npm should not make fails at once. */
const CLOSED_REGISTRY = 'http://127.0.0.1:9/';

const STORE_RECORD = 'store.json';
const NPM_LOG_TAIL_LINES = 40;

/** What about the machine decides which third-party files an install writes. */
export interface Platform {
  nodeMajor: string;
  npm: string;
  os: string;
  arch: string;
}

export function currentPlatform(npmVersion: string): Platform {
  return { nodeMajor: process.versions.node.split('.')[0] ?? '', npm: npmVersion.trim(), os: process.platform, arch: process.arch };
}

export interface PackedManifest {
  name: string;
  version: string;
  [field: string]: unknown;
}

/** One packed Pyric tarball: where it is, the integrity npm records for it, its packed manifest, and the size of each file it holds. */
export interface PackedPackage {
  name: string;
  file: string;
  integrity: string;
  manifest: PackedManifest;
  /** Each file under the package directory, by path, with its size: what an install of the tarball must hold. */
  files: ReadonlyMap<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A gzipped tarball, as `npm pack` writes one: its manifest, and the size of each file. */
export function readPackedPackage(file: string): PackedPackage {
  const bytes = readFileSync(file);
  const files = tarFiles(gunzipSync(bytes));
  const manifestFile = files.find((entry) => entry.path === 'package.json');
  if (manifestFile === undefined) throw new Error(`${file} has no package/package.json`);
  const manifest = JSON.parse(manifestFile.body.toString('utf8')) as PackedManifest;
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const sizes = new Map(files.map((entry) => [entry.path, entry.body.length]));
  return { name: manifest.name, file, integrity, manifest, files: sizes };
}

export function readPackedPackages(tarballs: Tarballs): PackedPackage[] {
  return [...tarballs.values()].map(readPackedPackage);
}

/** What decides a set's third-party packages, and nothing else. */
export interface KeyInputs {
  /** The set's package.json, its Pyric packages pinned to this run's tarballs. */
  manifest: string;
  npmrc?: string;
  packed: readonly PackedPackage[];
  platform: Platform;
}

/** Each dependency field with every Pyric package's spec replaced by one placeholder. */
function withPyricPlaceholders(fields: Record<string, unknown>, pyricNames: ReadonlySet<string>): Record<string, unknown> {
  const replace = (value: unknown) => {
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, spec]) => [name, pyricNames.has(name) ? PYRIC_SPEC : spec]));
  };
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, replace(value)]));
}

/** A published package's install fields, every Pyric package's spec replaced by the placeholder. */
function publishedInstallFields(manifest: PackedManifest, pyricNames: ReadonlySet<string>): Record<string, unknown> {
  const fields = PUBLISHED_INSTALL_FIELDS.filter((field) => manifest[field] !== undefined);
  const specs = Object.fromEntries(fields.filter((field) => PUBLISHED_SPEC_FIELDS.has(field)).map((field) => [field, sortedObject(manifest[field])]));
  const others = Object.fromEntries(fields.filter((field) => !PUBLISHED_SPEC_FIELDS.has(field)).map((field) => [field, sortedObject(manifest[field])]));
  return { ...withPyricPlaceholders(specs, pyricNames), ...others };
}

/** The key's inputs, written to `store.json` too. */
export function storeKeyInputs(inputs: KeyInputs): Record<string, unknown> {
  const manifest = JSON.parse(inputs.manifest) as Manifest;
  const pyricNames = new Set(inputs.packed.map((pack) => pack.name));
  const published = [...inputs.packed].sort((a, b) => a.name.localeCompare(b.name));
  const { nodeMajor, npm, os, arch } = inputs.platform;
  return {
    format: STORE_FORMAT,
    platform: { nodeMajor, npm, os, arch },
    project: { name: manifest.name ?? null, ...withPyricPlaceholders(installManifest(manifest), pyricNames) },
    npmrc: inputs.npmrc ?? null,
    published: published.map((pack) => ({ name: pack.name, ...publishedInstallFields(pack.manifest, pyricNames) })),
  };
}

export function storeKey(inputs: KeyInputs): string {
  return createHash('sha256').update(JSON.stringify(storeKeyInputs(inputs))).digest('hex').slice(0, 24);
}

type LockEntry = Record<string, unknown>;

export interface Lockfile {
  packages?: Record<string, LockEntry>;
  [field: string]: unknown;
}

/** The package name a lockfile path installs: `node_modules/a/node_modules/@s/b` is `@s/b`. */
function lockName(path: string): string {
  const marker = 'node_modules/';
  return path.slice(path.lastIndexOf(marker) + marker.length);
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
}

/** A manifest's `bin` the way npm writes it into a lockfile. */
function lockBin(manifest: PackedManifest): Record<string, string> | undefined {
  const clean = (path: unknown) => String(path).replace(/^\.\//, '');
  if (typeof manifest.bin === 'string') return { [manifest.name.split('/').pop() ?? manifest.name]: clean(manifest.bin) };
  if (!isRecord(manifest.bin)) return undefined;
  return Object.fromEntries(Object.entries(manifest.bin).map(([name, path]) => [name, clean(path)]));
}

function hasInstallScript(manifest: PackedManifest): boolean {
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  return INSTALL_SCRIPTS.some((script) => scripts[script] !== undefined);
}

/** A Pyric package's lockfile entry, made from this run's tarball. */
function restampEntry(entry: LockEntry, pack: PackedPackage, projectDir: string): LockEntry {
  const bin = lockBin(pack.manifest);
  return {
    version: pack.manifest.version,
    resolved: `file:${relative(projectDir, pack.file)}`,
    integrity: pack.integrity,
    ...pick(entry, PLACEMENT_FIELDS),
    ...pick(pack.manifest, MANIFEST_LOCK_FIELDS),
    ...(bin === undefined ? {} : { bin }),
    ...(hasInstallScript(pack.manifest) ? { hasInstallScript: true } : {}),
  };
}

/** The root entry, its Pyric specs taken from the project's package.json. */
function restampRoot(entry: LockEntry, manifest: Manifest, pyricNames: ReadonlySet<string>): LockEntry {
  const restamped: LockEntry = { ...entry };
  for (const field of ROOT_DEPENDENCY_FIELDS) {
    const locked = entry[field];
    const declared = manifest[field];
    if (!isRecord(locked) || !isRecord(declared)) continue;
    const pyricSpecs = Object.entries(declared).filter(([name]) => pyricNames.has(name));
    restamped[field] = { ...locked, ...Object.fromEntries(pyricSpecs) };
  }
  return restamped;
}

/** The stored lockfile with its Pyric entries pointing at this run's tarballs, for a tree in `projectDir`. */
export function restampLockfile(lock: Lockfile, options: { projectDir: string; manifest: Manifest; packed: readonly PackedPackage[] }): Lockfile {
  const byName = new Map(options.packed.map((pack) => [pack.name, pack]));
  const pyricNames = new Set(byName.keys());
  const restamp = ([path, entry]: [string, LockEntry]): [string, LockEntry] => {
    if (path === '') return [path, restampRoot(entry, options.manifest, pyricNames)];
    const pack = byName.get(lockName(path));
    const isLink = entry.link === true;
    return [path, pack === undefined || isLink ? entry : restampEntry(entry, pack, options.projectDir)];
  };
  return { ...lock, packages: Object.fromEntries(Object.entries(lock.packages ?? {}).map(restamp)) };
}

/** A lockfile path that installs a Pyric package, and the tarball it must hold. */
interface PyricInstall {
  path: string;
  pack: PackedPackage;
  /** Whether the lockfile entry already names this tarball, byte for byte. */
  isThisRuns: boolean;
}

/** Every path in the lockfile that installs a Pyric package from a tarball; a link holds no files of its own. */
function pyricInstalls(lock: Lockfile, packed: readonly PackedPackage[]): PyricInstall[] {
  const byName = new Map(packed.map((pack) => [pack.name, pack]));
  return Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
    const isPackage = path !== '' && entry.link !== true;
    const pack = isPackage ? byName.get(lockName(path)) : undefined;
    if (pack === undefined) return [];
    const isThisRuns = entry.integrity === pack.integrity && entry.version === pack.manifest.version;
    return [{ path, pack, isThisRuns }];
  });
}

/** The package names of `installs`, once each, for the runner line. */
function packageNames(installs: readonly PyricInstall[]): string {
  return [...new Set(installs.map(({ pack }) => pack.name))].join(', ');
}

/** How the Pyric packages in `projectDir` differ from their tarballs, one line each, naming the package. */
function pyricFileProblems(projectDir: string, installs: readonly PyricInstall[]): string[] {
  return installs.flatMap(({ path, pack }) => installedFileProblems(join(projectDir, path), pack.files).map((problem) => `${path}: ${problem}`));
}

/**
 * Remove each copied Pyric package's own files, keeping its nested
 * `node_modules`, which holds third-party packages the store installed. npm
 * then finds no package there and extracts this run's tarball.
 *
 * Without this, npm can keep the copied files (#1596). When the copy leaves
 * the hidden lockfile older than the directories copied after it, npm rejects
 * that lockfile and reads the tree from disk, taking each package's integrity
 * from package-lock.json, just restamped for this run's tarballs. A copied
 * package at the same version then looks like this run's, and npm reports
 * the set up to date.
 */
async function clearPyricFiles(projectDir: string, installs: readonly PyricInstall[]): Promise<void> {
  const removals = installs.flatMap(({ path }) => {
    const dir = join(projectDir, path);
    if (!existsSync(dir)) return [];
    const names = readdirSync(dir);
    const own = names.filter((name) => name !== 'node_modules');
    const hasNested = own.length < names.length;
    return hasNested ? own.map((name) => join(dir, name)) : [dir];
  });
  await Promise.all(removals.map((path) => rm(path, { recursive: true, force: true })));
}

/** Every third-party lockfile entry that `after` adds, removes or changes; the root and Pyric entries do not count. */
export function changedThirdPartyEntries(before: Lockfile, after: Lockfile, pyricNames: ReadonlySet<string>): string[] {
  const isThirdParty = (path: string) => path !== '' && !pyricNames.has(lockName(path));
  const paths = new Set([...Object.keys(before.packages ?? {}), ...Object.keys(after.packages ?? {})].filter(isThirdParty));
  const canonical = (entry: unknown) => JSON.stringify(sortedObject(entry) ?? null);
  return [...paths].filter((path) => canonical(before.packages?.[path]) !== canonical(after.packages?.[path])).sort();
}

/** Runs npm with `args` in `cwd`, stopping it at `timeoutMs`. */
export type RunNpm = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<TimedResult>;

export interface DependencyStoreOptions {
  /** The store's directory; locally `~/.cache/pyric-app-scenarios/deps`. */
  dir: string;
  /** With PYRIC_APPS_OFFLINE=1: a missing entry fails, and nothing installs from the registry. */
  offline: boolean;
  packed: readonly PackedPackage[];
  platform: Platform;
  /** The npm cache a warm installs through. */
  npmCache: string;
  runNpm: RunNpm;
  /** The registry the offline install is pointed at; by default a closed local port. */
  offlineRegistry?: string;
  warmAttemptMs?: number;
  materializeMs?: number;
}

/** A set's tree, made in its directory from the store. */
export interface ProvidedSet extends SetInstallResult {
  source: string;
  retryable: boolean;
  /** True when warming the entry was stopped at its time limit. */
  timedOut?: boolean;
}

/** What one `provide` call may change. */
export interface ProvideOptions {
  /** How long one warm gets, in place of the store's limit; a nested install keeps its own (#1476). */
  warmAttemptMs?: number;
}

type WarmResult = CommandResult & { timedOut?: boolean };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The way out of a failure the entry itself causes. The entry stays in the
 * store, so every later run would fail the same way until it is removed.
 */
function deleteToRewarm(entry: string): string {
  return `[runner] every later run fails the same way while this entry stands: delete ${entry} and the next run warms it again\n`;
}

/** The failure when npm's offline install left Pyric packages that are not this run's tarballs. */
function notThisRunsPackages(problems: readonly string[]): string {
  const list = problems.map((problem) => `  ${problem}`).join('\n');
  return `[runner] npm install --offline left Pyric packages that do not hold this run's tarballs, so the scenario would test other code:\n${list}\n`;
}

function secondsSince(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(1);
}

export class DependencyStore {
  private readonly warming = new Map<string, Promise<WarmResult>>();
  private readonly pyricNames: ReadonlySet<string>;

  constructor(private readonly options: DependencyStoreOptions) {
    this.pyricNames = new Set(options.packed.map((pack) => pack.name));
  }

  /** The store key of the project in `projectDir`. */
  keyOf(projectDir: string): string {
    return storeKey(this.keyInputs(projectDir));
  }

  /**
   * Make the tree of the project in `projectDir` (its package.json written,
   * no node_modules yet) from the store, warming its entry first on a miss
   * unless the store is offline. The caller owns the retry: a failed warm is
   * worth a second attempt; a miss offline and a failed offline install are not.
   */
  async provide(projectDir: string, app?: string, options: ProvideOptions = {}): Promise<ProvidedSet> {
    const inputs = this.keyInputs(projectDir);
    const key = storeKey(inputs);
    const entry = join(this.options.dir, key);
    const isMiss = !existsSync(entry);
    if (isMiss && this.options.offline) return this.offlineMiss(key, app);
    const warm = isMiss ? await this.warmOnce(key, inputs, options) : undefined;
    if (warm !== undefined && warm.code !== 0) return { ...warm, source: `warming store entry ${key} from the registry`, retryable: true };
    const { note, ...materialized } = await this.materialize(entry, projectDir);
    const source = warm === undefined ? `from the store, entry ${key}` : `warmed store entry ${key} from the registry`;
    return { ...materialized, output: `${warm?.output ?? ''}${materialized.output}`, source: `${source}${note}` };
  }

  private keyInputs(projectDir: string): KeyInputs {
    return {
      manifest: readFileSync(join(projectDir, 'package.json'), 'utf8'),
      npmrc: readOptional(join(projectDir, '.npmrc')),
      packed: this.options.packed,
      platform: this.options.platform,
    };
  }

  private offlineMiss(key: string, app: string | undefined): ProvidedSet {
    const forApp = app === undefined ? '' : ` for ${app}`;
    const output = `[runner] the dependency store has no entry ${key}${forApp} in ${this.options.dir}, and PYRIC_APPS_OFFLINE=1 installs nothing from the registry. Run without PYRIC_APPS_OFFLINE once to warm it.\n`;
    return { code: 1, output, source: `missing from the store, entry ${key}`, retryable: false };
  }

  /** One warm per key in this run, however many sets ask for it at once. */
  private warmOnce(key: string, inputs: KeyInputs, options: ProvideOptions): Promise<WarmResult> {
    const running = this.warming.get(key);
    if (running !== undefined) return running;
    const warm = this.warm(key, inputs, options).finally(() => this.warming.delete(key));
    this.warming.set(key, warm);
    return warm;
  }

  /** Install the set from the registry into a new directory, and rename it into place. */
  private async warm(key: string, inputs: KeyInputs, options: ProvideOptions): Promise<WarmResult> {
    const started = performance.now();
    const header = `[runner] warming store entry ${key} from the registry\n`;
    mkdirSync(this.options.dir, { recursive: true });
    const building = mkdtempSync(join(this.options.dir, `.warm-${key}-`));
    try {
      writeFileSync(join(building, 'package.json'), inputs.manifest);
      if (inputs.npmrc !== undefined) writeFileSync(join(building, '.npmrc'), inputs.npmrc);
      const result = await this.installFromRegistry(building, options.warmAttemptMs ?? this.options.warmAttemptMs ?? WARM_ATTEMPT_MS);
      if (result.code !== 0) return { code: result.code ?? 1, output: `${header}${result.output}`, timedOut: result.timedOut };
      if (!existsSync(join(building, 'package-lock.json'))) return { code: 1, output: `${header}${result.output}[runner] npm wrote no package-lock.json\n` };
      const record = { format: STORE_FORMAT, key, inputs: storeKeyInputs(inputs), warmedAt: new Date().toISOString(), warmSeconds: Number(secondsSince(started)) };
      writeFileSync(join(building, STORE_RECORD), `${JSON.stringify(record, null, 2)}\n`);
      this.publish(building, join(this.options.dir, key));
      return { code: 0, output: `${header}${result.output}` };
    } catch (error) {
      return { code: 1, output: `${header}[runner] warming failed: ${messageOf(error)}\n` };
    } finally {
      if (existsSync(building)) await removeTree(building);
    }
  }

  /** One online `npm install`, with its debug log; the log's end joins the output of an attempt that timed out. */
  private async installFromRegistry(dir: string, timeoutMs: number): Promise<TimedResult> {
    const logsDir = join(dir, '.npm-logs');
    const result = await npmInstall(this.options.npmCache, (args) => this.options.runNpm(args, { cwd: dir, timeoutMs }), logsDir);
    const tail = result.timedOut ? debugLogTail(logsDir, NPM_LOG_TAIL_LINES) : '';
    rmSync(logsDir, { recursive: true, force: true });
    return { ...result, code: result.timedOut ? null : result.code, output: `${result.output}${tail}` };
  }

  /** Rename a built entry into place. When another run got there first, its entry stands and this one is dropped. */
  private publish(building: string, entry: string): void {
    try {
      renameSync(building, entry);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const lostTheRace = (code === 'ENOTEMPTY' || code === 'EEXIST') && existsSync(entry);
      if (!lostTheRace) throw error;
    }
  }

  /**
   * Copy the entry's tree into `projectDir`, restamp its lockfile for this
   * run's tarballs, and install offline each Pyric package the entry does not
   * already hold as this run's tarball, file for file. When it holds them
   * all, there is nothing to install. Either way, the set is used only once
   * each Pyric package holds exactly its tarball's files.
   */
  private async materialize(entry: string, projectDir: string): Promise<CommandResult & { note: string; retryable: boolean }> {
    const failed = (output: string) => ({ code: 1, output, note: '', retryable: false });
    try {
      const stored = readJson<Lockfile>(join(entry, 'package-lock.json'));
      await copyTree(join(entry, 'node_modules'), join(projectDir, 'node_modules'));
      const manifest = readJson<Manifest>(join(projectDir, 'package.json'));
      const lock = restampLockfile(stored, { projectDir, manifest, packed: this.options.packed });
      writeFileSync(join(projectDir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
      const copied = pyricInstalls(stored, this.options.packed);
      // A copy whose lockfile entry names this run's tarball but whose files differ is not used as it is (#1585).
      const copyProblems = copied.filter((install) => install.isThisRuns).flatMap((install) => pyricFileProblems(projectDir, [install]).map((problem) => ({ path: install.path, problem })));
      const brokenPaths = new Set(copyProblems.map(({ path }) => path));
      const toInstall = copied.filter((install) => !install.isThisRuns || brokenPaths.has(install.path));
      if (toInstall.length === 0) return { code: 0, output: '', note: ', its Pyric packages already this run\'s', retryable: false };
      await clearPyricFiles(projectDir, toInstall);
      const installed = await this.installOffline(stored, entry, projectDir);
      if (installed.code !== 0) return installed;
      const problems = pyricFileProblems(projectDir, pyricInstalls(readJson<Lockfile>(join(projectDir, 'package-lock.json')), this.options.packed));
      if (problems.length > 0) return failed(`${installed.output}${notThisRunsPackages(problems)}`);
      const firstProblem = copyProblems[0]?.problem;
      const repaired = firstProblem === undefined ? '' : `, as the entry's own copies did not match its lockfile (${firstProblem})`;
      return { ...installed, note: `${installed.note} (${packageNames(toInstall)})${repaired}` };
    } catch (error) {
      return failed(`[runner] making the set from store entry ${entry} failed: ${messageOf(error)}\n${deleteToRewarm(entry)}`);
    }
  }

  private async installOffline(stored: Lockfile, entry: string, projectDir: string): Promise<CommandResult & { note: string; retryable: boolean }> {
    const started = performance.now();
    const cache = mkdtempSync(join(tmpdir(), 'pyric-offline-npm-cache-'));
    try {
      const args = npmOfflineInstallArgs(cache, this.options.offlineRegistry ?? CLOSED_REGISTRY);
      const result = await this.options.runNpm(args, { cwd: projectDir, timeoutMs: this.options.materializeMs ?? MATERIALIZE_MS });
      const header = `[runner] npm install --offline of this run's Pyric tarballs: ${result.timedOut ? 'timed out' : `exit ${result.code}`} in ${secondsSince(started)} s\n`;
      const output = `${header}${result.output}`;
      if (result.timedOut || result.code !== 0) return { code: result.code ?? 1, output: `${output}${deleteToRewarm(entry)}`, note: '', retryable: false };
      const changed = changedThirdPartyEntries(stored, readJson<Lockfile>(join(projectDir, 'package-lock.json')), this.pyricNames);
      if (changed.length > 0) {
        const list = changed.map((path) => `  ${path}`).join('\n');
        return { code: 1, output: `${output}[runner] the offline install changed third-party lockfile entries the store holds:\n${list}\n${deleteToRewarm(entry)}`, note: '', retryable: false };
      }
      return { code: 0, output, note: ', its Pyric packages installed offline', retryable: false };
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }
}

/** How the store keys a nested project: the create-pyric command that scaffolds a template, and the run's tarballs. */
export interface NestedManifestOptions {
  /** The directory that holds the apps, test/apps/. */
  appsDir: string;
  /** The command that runs create-pyric, such as `['node', 'node_modules/create-pyric/dist/bin.js']`. */
  createPyric: readonly string[];
  tarballs: Tarballs;
}

/** A nested project's package.json and .npmrc, as `installProject` keys them. */
export interface NestedManifest {
  manifest: string;
  npmrc?: string;
}

/** Writes the project's package.json (and .npmrc) at its path under `appDir`, from its template or its directory in the app. */
async function writeNestedProject(project: NestedProject, appDir: string, options: NestedManifestOptions): Promise<void> {
  const source = project.manifest;
  const projectDir = join(appDir, project.path);
  if ('dir' in source) {
    const from = join(options.appsDir, project.app, source.dir);
    mkdirSync(projectDir, { recursive: true });
    copyFileSync(join(from, 'package.json'), join(projectDir, 'package.json'));
    if (existsSync(join(from, '.npmrc'))) copyFileSync(join(from, '.npmrc'), join(projectDir, '.npmrc'));
    return;
  }
  const [command = 'node', ...args] = options.createPyric;
  // As the scenario runs it: from the app directory, with the project's path.
  const result = await runCommand(command, [...args, project.path, '--template', source.template], { cwd: appDir });
  if (result.code !== 0) throw new Error(`create-pyric --template ${source.template} exited with code ${result.code}:\n${result.output}`);
}

/**
 * The manifest a declared nested project has when `installProject` keys it:
 * scaffolded from its create-pyric template or copied from its directory in
 * the app, then pinned to the run's tarballs as `installProject` pins it.
 * With it, a project's store key is known before the run.
 */
export async function nestedProjectManifest(project: NestedProject, options: NestedManifestOptions): Promise<NestedManifest> {
  const work = mkdtempSync(join(tmpdir(), 'pyric-nested-manifest-'));
  try {
    const projectDir = join(work, project.path);
    await writeNestedProject(project, work, options);
    pinPyricPackages(projectDir, options.tarballs);
    return { manifest: readFileSync(join(projectDir, 'package.json'), 'utf8'), npmrc: readOptional(join(projectDir, '.npmrc')) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
