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
import { dirname, extname, isAbsolute, join } from 'node:path';
import {
  describeCompileLimitViolations,
  lintFirestoreRules,
  resolveModulesWithFiles,
  rulesSourceRejection,
  sourceCompileLimitViolations,
  type ResolveResult,
} from 'pyric/rules/internal';
import { asSentence, databaseInstanceKey, databaseInstanceNamed, defaultDatabaseInstanceName } from 'pyric/sandbox/internal';
import { parseStorageRules } from 'pyric/storage';
import { readFirebaseRcSync, type DatabaseRulesEntry, type FirebaseJson, type FirebaseRc } from '../cli/firebase-json.js';
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
  // limits, before it evaluates any request, so the sandbox does not serve
  // one either: the check every rules load path runs.
  const rejection = rulesSourceRejection(source);
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
 * The Firestore rules file the project deploys: `firebase.json`'s
 * `firestore.rules`, else `firestore.rules` in `cwd`. The file may not exist.
 */
export function firestoreRulesPath(cwd: string, config: FirebaseJson | null): string {
  const rel = config?.firestore?.rules ?? 'firestore.rules';
  return isAbsolute(rel) ? rel : join(cwd, rel);
}

/**
 * Load the project rules per `firebase.json` (`firestore.rules` path,
 * defaulting to `firestore.rules` in cwd when the key is absent but the file
 * exists). Missing file with no explicit config → `{ rules: null }` (serving
 * without rules is fine; the runtime logs it). Missing file that IS
 * explicitly configured → throw (the project says it should exist).
 */
export async function loadProjectRules(
  cwd: string,
  config: FirebaseJson | null,
): Promise<LoadedRules> {
  const configured = config?.firestore?.rules;
  const path = firestoreRulesPath(cwd, config);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (configured) {
        throw new Error(`pyric sandbox: firebase.json points firestore.rules at ${path}, but it does not exist.`);
      }
      return { rules: null, rulesHash: null, sourcePath: null, moduleFiles: [] };
    }
    throw e;
  }
  const { rules, moduleFiles } = prepareProjectRules(raw, path);
  return { rules, rulesHash: rulesHashOf(rules), sourcePath: path, moduleFiles };
}

/**
 * Resolve and validate a raw Storage rules source. Modular sources are
 * authored in storage.modules.rules and resolved in memory before the
 * sandbox sees them; firebase.json can continue to point at storage.rules.
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

/**
 * Load the project's storage rules per `firebase.json` (`storage.rules`
 * path — the block may be a single object or an array of per-bucket
 * entries; v1 has one implicit bucket, so the FIRST entry with a `rules`
 * path wins, defaulting to `storage.rules` in cwd when the block is absent
 * but the file exists). Missing file with no explicit config → `{ rules:
 * null }` (serving without storage rules is fine — same posture as
 * `loadProjectRules`). Missing file that IS explicitly configured → throw
 * (the project says it should exist).
 */
export async function loadProjectStorageRules(
  cwd: string,
  config: FirebaseJson | null,
): Promise<LoadedStorageRules> {
  const configured = configuredStorageRules(config);
  const path = storageRulesPath(cwd, config);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (configured) {
        throw new Error(`pyric sandbox: firebase.json points storage.rules at ${path}, but it does not exist.`);
      }
      return { rules: null, rulesHash: null, sourcePath: null };
    }
    throw e;
  }
  const rules = prepareStorageRulesSource(raw, path);
  return { rules, rulesHash: rulesHashOf(rules), sourcePath: path };
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

const DEFAULT_DATABASE_RULES_FILE = 'database.rules.json';

function databaseRulesFilePath(cwd: string, file: string): string {
  return isAbsolute(file) ? file : join(cwd, file);
}

// The rules formats `firebase deploy` accepts (lib/deploy/database/prepare.js).
function checkDatabaseRulesFormat(file: string, entry: string): void {
  const extension = extname(file);
  if (extension === '.json') return;
  const reason = extension === '.bolt'
    ? 'As of firebase-tools@15.0.0, .bolt rules are no longer supported.'
    : `Unexpected rules format ${extension}`;
  throw new Error(`pyric sandbox: ${entry}: ${reason}`);
}

/**
 * The rules files `firebase.json` deploys and the database instance each
 * deploys to, resolved as `firebase deploy` resolves them
 * (`lib/database/rulesConfig.js` `getRulesConfig` in firebase-tools 15.23.0):
 *
 * - A single object's `rules` deploys to `<projectId>-default-rtdb`. Without
 *   `rules` it deploys nothing.
 * - An array entry's `rules` deploys to every instance `.firebaserc` maps its
 *   `target` to, else to its `instance`. An entry with neither throws the
 *   CLI's error. An entry without `rules` deploys nothing.
 * - Where the CLI throws because no project is set or the project does not
 *   map a target, the target is returned in `pending` with every project's
 *   mapping, so a dev server starts and applies it once the page's app
 *   config names the project.
 * - Without a `database` key, `database.rules.json` in `cwd` deploys to the
 *   default instance when it exists.
 *
 * Instance names are normalized with {@link databaseInstanceNamed}. Two
 * entries that deploy different files to one instance are refused: the CLI
 * deploys both concurrently, so the configuration does not determine which
 * ruleset production keeps.
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
  const defaultInstance = projectId === undefined
    ? databaseInstanceKey(undefined)
    : defaultDatabaseInstanceName(projectId);

  const database = config?.database;
  if (database === undefined || database === null) {
    return {
      defaultInstance,
      targets: [{ instance: defaultInstance, path: join(cwd, DEFAULT_DATABASE_RULES_FILE), configured: false }],
      pending: [],
    };
  }
  if (!Array.isArray(database)) {
    const rules = typeof database === 'object' ? database.rules : undefined;
    if (typeof rules !== 'string' || rules === '') return { defaultInstance, targets: [], pending: [] };
    checkDatabaseRulesFormat(rules, 'firebase.json database.rules');
    return {
      defaultInstance,
      targets: [{ instance: defaultInstance, path: databaseRulesFilePath(cwd, rules), configured: true }],
      pending: [],
    };
  }

  const targets: DatabaseRulesTarget[] = [];
  const pending: PendingDatabaseRulesTarget[] = [];
  const entryOf = new Map<string, string>();
  database.forEach((raw, index) => {
    const label = `firebase.json database[${index}]`;
    const entry: DatabaseRulesEntry = raw !== null && typeof raw === 'object' ? raw : {};
    let names: readonly string[];
    let unresolved: string | null = null;
    if (entry.target) {
      names = projectId === undefined ? [] : readRc()?.targets?.[projectId]?.database?.[entry.target] ?? [];
      if (names.length === 0) {
        unresolved = projectId === undefined
          ? 'no Firebase project is set'
          : `project ${describeFirebaseProject(project)} has no .firebaserc mapping for it (firebase target:apply database ${entry.target} <instance>)`;
      }
    } else if (entry.instance) {
      names = [entry.instance];
    } else {
      throw new Error(`pyric sandbox: ${label}: Must supply either "target" or "instance" in database config`);
    }
    if (typeof entry.rules !== 'string' || entry.rules === '') return;
    checkDatabaseRulesFormat(entry.rules, label);
    const path = databaseRulesFilePath(cwd, entry.rules);
    if (unresolved !== null && entry.target) {
      pending.push({ target: entry.target, label, path, instancesByProject: targetMappings(readRc(), entry.target), reason: unresolved });
      return;
    }
    for (const name of names) {
      let instance: string;
      try {
        instance = databaseInstanceNamed(name).name;
      } catch (error) {
        const reason = error instanceof Error ? error.message.trim() : String(error);
        throw new Error(`pyric sandbox: ${label}: instance "${name}" is not a database instance name: ${reason}`);
      }
      const existing = targets.find((target) => target.instance === instance);
      if (existing === undefined) {
        targets.push({ instance, path, configured: true });
        entryOf.set(instance, label);
        continue;
      }
      if (existing.path === path) continue;
      throw new Error(
        `pyric sandbox: firebase.json deploys two rules files to database instance "${instance}": ${existing.path} from ${entryOf.get(instance)} and ${path} from ${label}. The Firebase CLI deploys both at once, so the configuration does not determine which one production keeps. Deploy one rules file to each instance.`,
      );
    }
  });
  return { defaultInstance, targets, pending };
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
  const { defaultInstance, targets, pending } = databaseRulesTargets(cwd, config, project);
  const instances = new Map<string, LoadedDatabaseInstanceRules>();
  for (const target of targets) {
    const loaded = await loadDatabaseInstanceRules(target);
    if (loaded !== null) instances.set(target.instance, loaded);
  }
  const loadedPending: LoadedPendingDatabaseTarget[] = [];
  for (const target of pending) loadedPending.push({ ...target, ...await loadPendingDatabaseTargetRules(target) });
  return {
    defaultInstance,
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
