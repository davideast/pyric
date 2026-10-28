/**
 * `pyric dev` rules wiring — load the project's `firestore.rules`, make it
 * executable for the in-page sandbox, and fail FAST at startup on broken
 * rules (a clear CLI error beats a silently rule-less page).
 *
 * `2+modules` sources are resolved node-side before embedding, with the
 * stdlib inlined and relative imports read from the project, so the page
 * runtime only ever sees plain-v2 source the in-browser evaluator understands. This is the
 * same lesson the playground's write_file learned (a capable model authored
 * correct modular rules that scored 0/5 unresolved — auth-sdk work, PR #525).
 */
import { createHash } from 'node:crypto';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  describeCompileLimitViolations,
  lintFirestoreRules,
  resolveModulesWithFiles,
  rulesSourceRejection,
  sourceCompileLimitViolations,
  type ResolveResult,
} from 'pyric/rules/internal';
import {
  asSentence,
  databaseRulesConfig,
  defaultFirestoreDatabase,
  firestoreRulesConfig,
  storageRulesConfig,
  unservedFirestoreDatabaseWarnings,
  type DatabaseRulesConfig,
  type StorageRulesConfig,
  type FirestoreRulesConfig,
} from 'pyric/sandbox/internal';
import { parseStorageRules } from 'pyric/storage';
import { compileStorageRules } from 'pyric/storage/internal';
import { readFirebaseRcSync, type FirebaseJson, type FirebaseRc } from '../cli/firebase-json.js';
import {
  describeFirebaseProject,
  FIREBASE_PROJECT_FIXES,
  FIREBASE_PROJECT_SOURCES_TRIED,
  type FirebaseProjectResolution,
} from '../cli/firebase-project.js';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { RtdbRulesJson } from './init-payload.js';
import { parseRtdbRulesText } from '../rtdb/rules-json.js';

export interface LoadedRules {
  /** Plain-v2 source ready for the sandbox, or null when the project has no
   *  rules file configured/present. */
  rules: string | null;
  rulesHash: string | null;
  /** Where it came from (diagnostics + the P3 watcher target). */
  sourcePath: string | null;
  /** Rules files of the project's own that the source imports, directly or
   *  through other modules. Watched alongside `sourcePath`. */
  moduleFiles: string[];
  /** One line per `firebase.json` Firestore entry pyric does not serve yet. */
  warnings: string[];
}

export interface LoadedStorageRules {
  /** Plain storage-rules source ready for the sandbox, or null when the
   *  project has no storage rules file configured/present. */
  rules: string | null;
  rulesHash: string | null;
  sourcePath: string | null;
}

export function rulesHashOf(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12);
}

const MODULAR_SOURCE = /^\s*rules_version\s*=\s*['"]2\+modules['"]/m;

interface ProjectModulesResolution {
  result: ResolveResult;
  /** Every project file the resolver asked for, found or not, as absolute paths. */
  moduleFiles: string[];
}

/**
 * Resolve a modular source: the stdlib inlined, relative imports read from
 * beside `sourcePath`. The resolver names nested imports relative to the
 * source, so every file it asks for is under `sourcePath`'s directory.
 */
function resolveProjectModules(raw: string, sourcePath: string, sourceFile?: string): ProjectModulesResolution {
  const basePath = dirname(sourcePath);
  const moduleFiles: string[] = [];
  const readProjectRulesFile = (base: string, moduleName: string): string | null => {
    const fileName = moduleName.endsWith('.rules') ? moduleName : `${moduleName}.rules`;
    const file = join(base, fileName);
    if (!moduleFiles.includes(file)) moduleFiles.push(file);
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const options = sourceFile === undefined ? { basePath } : { basePath, sourceFile };
  const result = resolveModulesWithFiles(raw, readProjectRulesFile, options);
  return { result, moduleFiles };
}

export interface PreparedRules {
  rules: string;
  /** Rules files of the project's own that the source imports. */
  moduleFiles: string[];
}

/**
 * A rules source that failed to resolve, parse or lint. `moduleFiles` lists
 * the project files its resolution asked for, found or not, so a watcher can
 * reload when one of them is fixed or created.
 */
export class RulesPrepareError extends Error {
  readonly moduleFiles: readonly string[];

  constructor(message: string, moduleFiles: readonly string[]) {
    super(message);
    this.name = 'RulesPrepareError';
    this.moduleFiles = moduleFiles;
  }
}

/**
 * Resolve + lint a raw rules source into sandbox-ready plain v2.
 * Throws with an actionable message on unresolvable imports or lint errors.
 */
export function prepareRulesSource(raw: string, sourcePath: string): string {
  return prepareProjectRules(raw, sourcePath).rules;
}

/**
 * {@link prepareRulesSource}, also reporting the module files the source
 * imports. Throws a {@link RulesPrepareError} that lists the module files the
 * failed source asked for.
 */
export function prepareProjectRules(raw: string, sourcePath: string): PreparedRules {
  let source = raw;
  let moduleFiles: string[] = [];
  if (MODULAR_SOURCE.test(raw)) {
    const resolution = resolveProjectModules(raw, sourcePath);
    moduleFiles = resolution.moduleFiles;
    const resolved = resolution.result;
    if (!resolved.success) {
      throw new RulesPrepareError(
        `pyric sandbox: ${sourcePath} uses 2+modules but module resolution failed: ${resolved.error.message}`,
        moduleFiles,
      );
    }
    source = resolved.data.resolved;
  }
  // Production rejects a ruleset that does not parse, or is past its compile
  // limits, or names a service other than cloud.firestore, before it
  // evaluates any request, so the sandbox does not serve one either: the
  // check every rules load path runs, with the reason every plane gives.
  const rejection = rulesSourceRejection(source);
  if (rejection?.kind === 'parse' && rejection.otherService !== undefined) {
    throw new RulesPrepareError(
      `pyric sandbox: ${sourcePath}: Firestore ${rejection.message} Fix the rules before serving.`,
      moduleFiles,
    );
  }
  if (rejection?.kind === 'parse') {
    throw new RulesPrepareError(
      `pyric sandbox: ${sourcePath} failed to parse (line ${rejection.line}, col ${rejection.column}). Fix the rules before serving.`,
      moduleFiles,
    );
  }
  if (rejection?.kind === 'compile') {
    throw new RulesPrepareError(
      `pyric sandbox: ${sourcePath} does not compile: ${describeCompileLimitViolations(rejection.violations)} Fix the rules before serving.`,
      moduleFiles,
    );
  }
  const lint = lintFirestoreRules(source);
  const errors = lint.warnings.filter((w) => w.severity === 'error');
  if (errors.length > 0) {
    throw new RulesPrepareError(
      `pyric sandbox: ${sourcePath} has ${errors.length} rules error(s):\n` +
        errors.map((e) => `  - ${e.message}`).join('\n'),
      moduleFiles,
    );
  }
  return { rules: source, moduleFiles };
}

/**
 * Where a project's Firestore deploy targets resolve from: the project id
 * and `.firebaserc`. Without a project id, target entries stay unresolved.
 */
export interface FirestoreRulesProject {
  projectId?: string;
  /** Reads `.firebaserc`. Defaults to reading it from the project directory. */
  readRc?: () => FirebaseRc | null;
}

/**
 * The Firestore databases `firebase.json` deploys to, resolved by
 * {@link firestoreRulesConfig} as `firebase deploy` resolves them, with files
 * as absolute paths.
 */
export function firestoreDatabases(
  cwd: string,
  config: FirebaseJson | null,
  project: FirestoreRulesProject = {},
): FirestoreRulesConfig {
  const { projectId } = project;
  const readRc = project.readRc ?? (() => readFirebaseRcSync(cwd));
  try {
    return firestoreRulesConfig(config?.firestore, {
      targetDatabases: (target) => projectId === undefined ? [] : readRc()?.targets?.[projectId]?.firestore?.[target] ?? [],
      resolveFile: (file) => isAbsolute(file) ? file : join(cwd, file),
    });
  } catch (error) {
    throw new Error(`pyric sandbox: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The rules file `firebase.json` deploys to the `(default)` Firestore
 * database, else `firestore.rules` in `cwd` when `firebase.json` names none.
 * Null when an array form deploys no rules to `(default)`. The file may not
 * exist.
 */
export function firestoreRulesPath(
  cwd: string,
  config: FirebaseJson | null,
  project: FirestoreRulesProject = {},
): string | null {
  return defaultFirestoreDatabase(firestoreDatabases(cwd, config, project))?.rulesFile ?? null;
}

/**
 * Load the `(default)` database's rules per `firebase.json`, resolved by
 * {@link firestoreDatabases}. Missing file with no explicit config, or no
 * rules for `(default)` → `{ rules: null }` (serving without rules is fine;
 * the runtime logs it). Missing file that IS explicitly configured → throw
 * (the project says it should exist). `warnings` names each named database
 * and unresolved target pyric does not serve yet.
 */
export async function loadProjectRules(
  cwd: string,
  config: FirebaseJson | null,
  project: FirestoreRulesProject = {},
): Promise<LoadedRules> {
  const databases = firestoreDatabases(cwd, config, project);
  const warnings = firestoreDatabaseWarnings(cwd, databases);
  const entry = defaultFirestoreDatabase(databases);
  const path = entry?.rulesFile;
  const none: LoadedRules = { rules: null, rulesHash: null, sourcePath: null, moduleFiles: [], warnings };
  if (entry === undefined || path === undefined) return none;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (entry.configured) {
        throw new Error(`pyric sandbox: ${entry.label} points Firestore rules at ${path}, but it does not exist.`);
      }
      return none;
    }
    throw e;
  }
  const { rules, moduleFiles } = prepareProjectRules(raw, path);
  return { rules, rulesHash: rulesHashOf(rules), sourcePath: path, moduleFiles, warnings };
}

/** One warning per Firestore database `firebase.json` declares that pyric does not serve yet, files named relative to `cwd`. */
export function firestoreDatabaseWarnings(cwd: string, databases: FirestoreRulesConfig): string[] {
  return unservedFirestoreDatabaseWarnings(databases, (file) => relativeToProject(cwd, file));
}

function relativeToProject(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  const isInsideProject = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  return isInsideProject ? rel : file;
}

/** `compileStorageRules` opens some of its reasons with this; the message here says it already. */
const STORAGE_COMPILE_PREFIX = /^Storage rules do not compile: /;

/**
 * Resolve and validate a raw Storage rules source. Modular sources are
 * authored in storage.modules.rules and resolved in memory before the
 * sandbox sees them; firebase.json can continue to point at storage.rules.
 * The source is checked by the sandbox's own install gate,
 * `compileStorageRules`, so every source this accepts installs on every
 * plane, and a reload this refuses is reported as refused.
 */
export function prepareStorageRulesSource(raw: string, sourcePath: string): string {
  let source = raw;
  if (MODULAR_SOURCE.test(raw)) {
    const resolved = resolveProjectModules(raw, sourcePath, sourcePath).result;
    if (!resolved.success) {
      throw new Error(
        `pyric sandbox: ${sourcePath} uses 2+modules but module resolution failed: ${resolved.error.message}`,
      );
    }
    source = resolved.data.resolved;
  }
  try {
    parseStorageRules(source);
  } catch (e) {
    const violations = sourceCompileLimitViolations(source);
    if (violations.length > 0) {
      throw new Error(
        `pyric sandbox: ${sourcePath} does not compile: ${describeCompileLimitViolations(violations)} Fix the rules before serving.`,
      );
    }
    throw new Error(
      `${asSentence(`pyric sandbox: ${sourcePath} failed to parse: ${e instanceof Error ? e.message : String(e)}`)} Fix the rules before serving.`,
    );
  }
  try {
    compileStorageRules(source);
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(STORAGE_COMPILE_PREFIX, '');
    throw new Error(`${asSentence(`pyric sandbox: ${sourcePath} does not compile: ${reason}`)} Fix the rules before serving.`);
  }
  return source;
}

function configuredStorageRules(config: FirebaseJson | null): string | undefined {
  const block = config?.storage;
  const entries = block ? (Array.isArray(block) ? block : [block]) : [];
  return entries.find((e) => e && typeof e === 'object' && e.rules)?.rules;
}

/**
 * The Storage rules file the project deploys: the first `firebase.json`
 * `storage` entry with a `rules` path, else `storage.rules` in `cwd`. The
 * file may not exist.
 */
export function storageRulesPath(cwd: string, config: FirebaseJson | null): string {
  const rel = configuredStorageRules(config) ?? 'storage.rules';
  return isAbsolute(rel) ? rel : join(cwd, rel);
}

/** The notice a dev server logs when the Storage rules file it loaded is
 *  deleted and Storage returns to denying every client operation. */
export function formatStorageRulesRemoved(path: string): string {
  return `storage rules removed: ${path} does not exist, client Storage operations default to DENY`;
}

/** One Storage rules file deployed to one bucket, or to the app's default bucket. */
export interface StorageRulesTarget {
  /** The bucket by name, or null for the app's default bucket, whose name the page's app config gives. */
  bucket: string | null;
  /** Absolute path of the rules file. */
  path: string;
  /** The `firebase.json` entry, such as `firebase.json storage[0]`. */
  label: string;
  /** True when `firebase.json` names the file, so a missing file is an error. */
  configured: boolean;
}

/** A Storage deploy target no `.firebaserc` mapping resolved at startup. Its buckets stay locked. */
export interface PendingStorageRulesTarget {
  target: string;
  label: string;
  /** Absolute path of the rules file. */
  path: string;
  /** Why the target did not resolve at startup. */
  reason: string;
}

/** The buckets `firebase.json` deploys Storage rules to. */
export interface StorageRulesTargets {
  /** One entry per bucket, the default bucket's first when it has one. */
  targets: StorageRulesTarget[];
  /** Target entries no `.firebaserc` mapping resolved, in `firebase.json` order. */
  pending: PendingStorageRulesTarget[];
}

/** One bucket's loaded rules. */
export interface LoadedStorageBucketRules {
  /** The bucket by name, or null for the app's default bucket. */
  bucket: string | null;
  rules: string;
  rulesHash: string;
  sourcePath: string;
}

export interface LoadedProjectStorageRules extends LoadedStorageRules, StorageRulesTargets {
  /** The rules each bucket `firebase.json` names gets, by bucket name; the default bucket's are `rules`. */
  buckets: Map<string, LoadedStorageBucketRules>;
}

/** How a Storage deploy names its bucket in a log line. */
export function storageBucketLabel(bucket: string | null): string {
  return bucket === null ? 'the default bucket' : `bucket ${bucket}`;
}

/**
 * The rules files `firebase.json` deploys to Storage and the bucket each
 * deploys to, resolved as `firebase deploy` resolves them by the shared
 * `storageRulesConfig`, with deploy targets mapped for the project
 * {@link resolveFirebaseProject} resolved.
 */
export function storageRulesTargets(
  cwd: string,
  config: FirebaseJson | null,
  project: DatabaseRulesProject = {},
): StorageRulesTargets {
  let rc: FirebaseRc | null | undefined;
  const readRc = (): FirebaseRc | null => {
    rc ??= (project.readRc ?? (() => readFirebaseRcSync(cwd)))();
    return rc;
  };
  const projectId = project.projectId;
  let resolved: StorageRulesConfig;
  try {
    resolved = storageRulesConfig(config?.storage, {
      targetBuckets: (target) => projectId === undefined ? [] : readRc()?.targets?.[projectId]?.storage?.[target] ?? [],
      resolveFile: (file) => databaseRulesFilePath(cwd, file),
    });
  } catch (error) {
    throw new Error(`pyric sandbox: ${error instanceof Error ? error.message : String(error)}`);
  }
  const named: StorageRulesTarget[] = resolved.buckets.map((target) => ({
    bucket: target.bucket,
    path: target.file,
    label: target.label,
    configured: target.configured,
  }));
  const defaultRules = resolved.defaultRules;
  const unnamed: StorageRulesTarget[] = defaultRules === null
    ? []
    : [{ bucket: null, path: defaultRules.file, label: defaultRules.label, configured: defaultRules.configured }];
  return {
    targets: [...unnamed, ...named],
    pending: resolved.unresolved.map((target) => ({
      target: target.target,
      label: target.label,
      path: target.file,
      reason: projectId === undefined
        ? 'no Firebase project is set'
        : `project ${describeFirebaseProject(project)} has no .firebaserc mapping for it (firebase target:apply storage ${target.target} <bucket>)`,
    })),
  };
}

/** The startup warning for Storage deploy targets no project resolved: each target, why, and how to fix it. */
export function formatUnresolvedStorageTargets(pending: readonly PendingStorageRulesTarget[]): string {
  const lines = pending.map((target) =>
    `  ⚠ Storage deploy target "${target.target}" (${target.label}) is unresolved: ${target.reason}. Its buckets deny every client operation.`);
  lines.push(`    To set the project: ${FIREBASE_PROJECT_FIXES}.`);
  return lines.join('\n');
}

/**
 * Load one Storage rules file through the check every rules load path runs.
 * Returns null for a missing file `firebase.json` does not name. Throws,
 * naming the file, for a missing file it names.
 */
export async function loadStorageRulesTarget(target: StorageRulesTarget): Promise<LoadedStorageBucketRules | null> {
  let raw: string;
  try {
    raw = await readFile(target.path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (!target.configured) return null;
    throw new Error(`pyric sandbox: ${target.label} points the rules of ${storageBucketLabel(target.bucket)} at ${target.path}, but it does not exist.`);
  }
  const rules = prepareStorageRulesSource(raw, target.path);
  return { bucket: target.bucket, rules, rulesHash: rulesHashOf(rules), sourcePath: target.path };
}

/**
 * Load the project's Storage rules per bucket, as `firebase deploy` would
 * release them. The default bucket's rules, from the single `storage` object
 * or `storage.rules` with no `storage` key, are `rules`; each bucket an array
 * entry names has its own in `buckets`. A bucket nothing deploys to is
 * locked once the rules are installed.
 */
export async function loadProjectStorageRules(
  cwd: string,
  config: FirebaseJson | null,
  project: DatabaseRulesProject = {},
): Promise<LoadedProjectStorageRules> {
  const targets = storageRulesTargets(cwd, config, project);
  const buckets = new Map<string, LoadedStorageBucketRules>();
  let defaultRules: LoadedStorageBucketRules | null = null;
  for (const target of targets.targets) {
    const loaded = await loadStorageRulesTarget(target);
    if (loaded === null) continue;
    if (target.bucket === null) defaultRules = loaded;
    else buckets.set(target.bucket, loaded);
  }
  return {
    ...targets,
    buckets,
    rules: defaultRules?.rules ?? null,
    rulesHash: defaultRules?.rulesHash ?? null,
    sourcePath: defaultRules?.sourcePath ?? null,
  };
}

/**
 * Where a project's database instance names come from: the project
 * {@link resolveFirebaseProject} resolved. The loader reads no project of its
 * own; without a project id, target entries start unresolved.
 */
export interface DatabaseRulesProject extends FirebaseProjectResolution {
  /** Reads `.firebaserc`. Defaults to reading it from the project directory. */
  readRc?: () => FirebaseRc | null;
}

/**
 * A `firebase.json` target entry no `.firebaserc` mapping resolved at
 * startup, because no project is set or the project does not map the target.
 * Its rules apply once the page's app config names a project that
 * `.firebaserc` maps the target for.
 */
export interface PendingDatabaseRulesTarget {
  /** The deploy target name. */
  target: string;
  /** The `firebase.json` entry, as `firebase.json database[0]`. */
  label: string;
  /** Absolute path of the rules file. */
  path: string;
  /** The instance names `.firebaserc` maps the target to, by project id. */
  instancesByProject: Record<string, string[]>;
  /** Why the target did not resolve at startup. */
  reason: string;
}

/** A pending target with its loaded rules. */
export interface LoadedPendingDatabaseTarget extends PendingDatabaseRulesTarget {
  rules: RtdbRulesJson;
  rulesHash: string;
}

/** One rules file deployed to one database instance. */
export interface DatabaseRulesTarget {
  /** The instance name, as the SDK names it. */
  instance: string;
  /** Absolute path of the rules file. */
  path: string;
  /** True when `firebase.json` names the file, so a missing file is an error. */
  configured: boolean;
}

/** The database instances `firebase.json` deploys rules to. */
export interface DatabaseRulesTargets {
  /** The instance `getDatabase()` selects without a URL. */
  defaultInstance: string;
  /** The project the rules were resolved for, when one is set; it also names the default instance. */
  projectId?: string;
  /** One entry per instance, in `firebase.json` order. */
  targets: DatabaseRulesTarget[];
  /** Target entries no `.firebaserc` mapping resolved, in `firebase.json` order. */
  pending: PendingDatabaseRulesTarget[];
}

/** One instance's loaded rules. */
export interface LoadedDatabaseInstanceRules {
  instance: string;
  rules: RtdbRulesJson;
  rulesHash: string;
  sourcePath: string;
}

export interface LoadedDatabaseRules extends Omit<DatabaseRulesTargets, 'pending'> {
  /** The unresolved target entries, with their rules. */
  pending: LoadedPendingDatabaseTarget[];
  /** Every instance `firebase.json` deploys rules to, whether or not its file exists. */
  declared: ReadonlySet<string>;
  /** The rules of each declared instance whose rules file exists. */
  instances: Map<string, LoadedDatabaseInstanceRules>;
}

function databaseRulesFilePath(cwd: string, file: string): string {
  return isAbsolute(file) ? file : join(cwd, file);
}

/**
 * The rules files `firebase.json` deploys and the database instance each
 * deploys to, resolved as `firebase deploy` resolves them by
 * {@link databaseRulesConfig}. Where the CLI throws because no project is
 * set or the project does not map a target, the target is returned in
 * `pending` with every project's mapping, so a dev server starts and applies
 * it once the page's app config names the project.
 */
export function databaseRulesTargets(
  cwd: string,
  config: FirebaseJson | null,
  project: DatabaseRulesProject = {},
): DatabaseRulesTargets {
  let rc: FirebaseRc | null | undefined;
  const readRc = (): FirebaseRc | null => {
    rc ??= (project.readRc ?? (() => readFirebaseRcSync(cwd)))();
    return rc;
  };
  const projectId = project.projectId;
  let resolved: DatabaseRulesConfig;
  try {
    resolved = databaseRulesConfig(config?.database, {
      ...(projectId === undefined ? {} : { projectId }),
      targetInstances: (target) => projectId === undefined ? [] : readRc()?.targets?.[projectId]?.database?.[target] ?? [],
      resolveFile: (file) => databaseRulesFilePath(cwd, file),
    });
  } catch (error) {
    throw new Error(`pyric sandbox: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    defaultInstance: resolved.defaultInstance,
    ...(projectId === undefined ? {} : { projectId }),
    targets: resolved.targets.map((target) => ({ instance: target.instance, path: target.file, configured: target.configured })),
    pending: resolved.unresolved.map((target) => ({
      target: target.target,
      label: target.label,
      path: target.file,
      instancesByProject: targetMappings(readRc(), target.target),
      reason: projectId === undefined
        ? 'no Firebase project is set'
        : `project ${describeFirebaseProject(project)} has no .firebaserc mapping for it (firebase target:apply database ${target.target} <instance>)`,
    })),
  };
}

/** The instance names `.firebaserc` maps `target` to, for each project that maps it. */
function targetMappings(rc: FirebaseRc | null, target: string): Record<string, string[]> {
  const mappings: Record<string, string[]> = {};
  for (const [projectId, types] of Object.entries(rc?.targets ?? {})) {
    const names = types?.database?.[target];
    if (Array.isArray(names) && names.length > 0) mappings[projectId] = [...names];
  }
  return mappings;
}

/**
 * The startup warning for target entries no project resolved: each target,
 * why, the sources tried, how its instances are served meanwhile, and the
 * ways to set the project.
 */
export function formatUnresolvedDatabaseTargets(
  pending: readonly PendingDatabaseRulesTarget[],
  policy: 'allow' | 'deny',
): string {
  const lines = pending.map((target) =>
    `  ⚠ RTDB deploy target "${target.target}" (${target.label}) is unresolved: ${target.reason}.`);
  const access = policy === 'allow' ? 'allow every read and write (permissive mode)' : 'deny every read and write';
  lines.push(
    `    Tried ${FIREBASE_PROJECT_SOURCES_TRIED}.`,
    `    Until a project maps the target, its instances ${access}. When the page's app config names a project .firebaserc maps the target for, its rules apply then.`,
    `    To set the project: ${FIREBASE_PROJECT_FIXES}.`,
  );
  return lines.join('\n');
}

/**
 * Load one instance's rules file through the check every rules load path
 * runs: a ruleset production's deploy would refuse is not served. Returns
 * null for a missing file `firebase.json` does not name. Throws, naming the
 * instance and file, for a missing configured file and for refused rules.
 */
export async function loadDatabaseInstanceRules(target: DatabaseRulesTarget): Promise<LoadedDatabaseInstanceRules | null> {
  const { instance, path } = target;
  const loaded = await loadDatabaseRulesFile(path, `pyric sandbox: database instance "${instance}": ${path}`, target.configured);
  return loaded === null ? null : { instance, ...loaded, sourcePath: path };
}

/**
 * Load an unresolved target's rules file through the same check. Throws,
 * naming the target and file, for a missing file and for refused rules.
 */
export async function loadPendingDatabaseTargetRules(
  target: PendingDatabaseRulesTarget,
): Promise<{ rules: RtdbRulesJson; rulesHash: string }> {
  const label = `pyric sandbox: database deploy target "${target.target}": ${target.path}`;
  const loaded = await loadDatabaseRulesFile(target.path, label, true);
  if (loaded === null) throw new Error(`${label} does not exist, and firebase.json deploys it.`);
  return loaded;
}

async function loadDatabaseRulesFile(
  path: string,
  label: string,
  configured: boolean,
): Promise<{ rules: RtdbRulesJson; rulesHash: string } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (configured) throw new Error(`${label} does not exist, and firebase.json deploys it.`);
      return null;
    }
    throw e;
  }
  const rules = parseRtdbRulesText(
    raw,
    (reason) => new Error(`${label} did not parse as RTDB rules JSON: ${reason.message}.`),
  );
  const rejection = rtdbRulesSourceRejection(rules);
  if (rejection !== null) {
    throw new Error(`${label} is not valid RTDB rules. ${rejection.message} Fix the rules before serving.`);
  }
  return { rules, rulesHash: rulesHashOf(raw) };
}

/** Load the rules of every database instance `firebase.json` deploys to. */
export async function loadProjectDatabaseRules(
  cwd: string,
  config: FirebaseJson | null,
  project: DatabaseRulesProject = {},
): Promise<LoadedDatabaseRules> {
  const { defaultInstance, projectId, targets, pending } = databaseRulesTargets(cwd, config, project);
  const instances = new Map<string, LoadedDatabaseInstanceRules>();
  for (const target of targets) {
    const loaded = await loadDatabaseInstanceRules(target);
    if (loaded !== null) instances.set(target.instance, loaded);
  }
  const loadedPending: LoadedPendingDatabaseTarget[] = [];
  for (const target of pending) loadedPending.push({ ...target, ...await loadPendingDatabaseTargetRules(target) });
  return {
    defaultInstance,
    ...(projectId === undefined ? {} : { projectId }),
    targets,
    pending: loadedPending,
    declared: new Set(targets.map((target) => target.instance)),
    instances,
  };
}

/** The notice a dev server logs when an instance's Realtime Database rules
 *  file is deleted and that instance returns to the default policy. */
export function formatDatabaseRulesRemoved(path: string, policy: 'allow' | 'deny', instance: string): string {
  const access = policy === 'allow' ? 'are open (permissive mode)' : 'default to DENY (matching production Firebase)';
  return `rtdb rules removed: ${path} does not exist, client RTDB reads/writes on instance ${instance} ${access}`;
}

/**
 * Watch the rules file and invoke `onChange` with freshly prepared
 * (resolved + linted) source. Broken intermediate saves are LOGGED and
 * skipped — the last-good ruleset stays live (the write_file lesson:
 * never replace a working ruleset with un-evaluatable source).
 * Debounced; returns the watcher for shutdown.
 */
export function watchProjectRules(
  sourcePath: string,
  onChange: (next: { rules: string; rulesHash: string }) => void,
  onError: (message: string) => void,
  debounceMs = 150,
): FSWatcher {
  return watchRulesFile(sourcePath, prepareRulesSource, onChange, onError, debounceMs);
}

/**
 * Shared watch implementation. Broken intermediate saves are LOGGED and
 * skipped — the last-good ruleset stays live (the write_file lesson: never
 * replace a working ruleset with un-evaluatable source). Debounced; returns
 * the watcher for shutdown.
 */
function watchRulesFile(
  sourcePath: string,
  prepare: (raw: string, sourcePath: string) => string,
  onChange: (next: { rules: string; rulesHash: string }) => void,
  onError: (message: string) => void,
  debounceMs: number,
): FSWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(sourcePath, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void readFile(sourcePath, 'utf8').then(
        (raw) => {
          try {
            const rules = prepare(raw, sourcePath);
            onChange({ rules, rulesHash: rulesHashOf(rules) });
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        },
        (e) => onError(e instanceof Error ? e.message : String(e)),
      );
    }, debounceMs);
  });
  // An FSWatcher with no 'error' listener throws at the event-loop level on
  // watcher failure (EMFILE, the watched file renamed away on some platforms)
  // and would kill the serve process. Degrade to "no hot reload" instead.
  watcher.on('error', (e) =>
    onError(`rules watcher failed (hot reload off): ${e instanceof Error ? e.message : String(e)}`),
  );
  return watcher;
}
