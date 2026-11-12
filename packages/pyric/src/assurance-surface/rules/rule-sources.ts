/**
 * Where an app's security rules come from: files named on the command
 * line, the `firestore`, `database`, and `storage` entries of `firebase.json`
 * (single or per-target/per-bucket arrays), and rules the app installs from
 * code. RTDB rules files are read with Pyric's JSON-with-comments reader.
 *
 * Browser-clean: acquires `node:fs` and `node:path` lazily via
 * `process.getBuiltinModule` when loading files from disk.
 */
import {
  resolveModulesBrowser,
  resolveModulesWithFiles,
} from '../../rules/internal/index.js';
import { toStrictRulesJson } from '../../rules/internal/rtdb.js';
import { isDefaultDatabaseInstance } from '@pyric/rules/internal/rtdb';
import {
  expandBareModuleImports,
  isHeaderOnlyRulesVersionStub,
  isModularRulesSource,
  lookupInMemoryModule,
  preNormalizeModularSyntax,
  restoreDefaultDbSentinelText,
  validateRulesSourceSyntax,
} from './rules-ast-utils.js';

interface NodeFsBuiltin {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  lstatSync?: (path: string) => { isSymbolicLink(): boolean };
  realpathSync?: (path: string) => string;
}

interface NodePathBuiltin {
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

interface RuleSourceBuiltins {
  readonly fs: NodeFsBuiltin;
  readonly path: NodePathBuiltin;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: () => string;
}

function acquireRuleSourceBuiltins(): RuleSourceBuiltins | null {
  const proc = (
    globalThis as {
      process?: {
        getBuiltinModule?: (id: string) => unknown;
        env?: Readonly<Record<string, string | undefined>>;
      };
    }
  ).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  const fs = get.call(proc, 'node:fs') as NodeFsBuiltin | undefined;
  const path = get.call(proc, 'node:path') as NodePathBuiltin | undefined;
  const os = get.call(proc, 'node:os') as { homedir?: () => string } | undefined;
  if (!fs || !path || typeof fs.readFileSync !== 'function') return null;
  const out: {
    fs: NodeFsBuiltin;
    path: NodePathBuiltin;
    env?: Readonly<Record<string, string | undefined>>;
    homedir?: () => string;
  } = { fs, path };
  if (proc?.env !== undefined) {
    out.env = proc.env;
  }
  if (typeof os?.homedir === 'function') {
    out.homedir = () => os.homedir!();
  }
  return out;
}

/** Firestore rules text, where it came from, and optional database target. */
export interface FirestoreRuleSource {
  source: string;
  text: string;
  database?: string;
}

/** RTDB rules object, where it came from, and optional instance target. */
export interface RtdbRuleSource {
  source: string;
  json: unknown;
  instance?: string;
}

/** Cloud Storage rules text, where it came from, and optional bucket target. */
export interface StorageRuleSource {
  source: string;
  text: string;
  bucket?: string;
}

export interface RuleSources {
  firestore: FirestoreRuleSource[];
  rtdb: RtdbRuleSource[];
  storage?: StorageRuleSource[];
  /** Files named but unreadable or unparsable, with why. */
  problems: string[];
}

/** Read an RTDB rules file, accepting comments and trailing commas. */
export function parseRtdbRulesText(text: string): unknown {
  return JSON.parse(toStrictRulesJson(text));
}

function rel(pathMod: NodePathBuiltin, root: string, file: string): string {
  return pathMod.relative(root, file).split(pathMod.sep).join('/');
}

function isWithinRoot(pathMod: NodePathBuiltin, baseDir: string, targetPath: string): boolean {
  const relativePath = pathMod.relative(baseDir, targetPath);
  if (relativePath === '') return true;
  if (relativePath === '..') return false;
  if (relativePath.startsWith(`..${pathMod.sep}`) || relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
    return false;
  }
  return !pathMod.isAbsolute(relativePath);
}

function assertNotSymlink(fsMod: NodeFsBuiltin, file: string): void {
  if (typeof fsMod.lstatSync !== 'function') return;
  if (fsMod.lstatSync(file).isSymbolicLink()) {
    throw new Error('Symbolic links are not followed');
  }
}

function resolveRealRoot(fsMod: NodeFsBuiltin, absRoot: string): string {
  if (typeof fsMod.realpathSync !== 'function') return absRoot;
  try {
    return fsMod.realpathSync(absRoot);
  } catch {
    return absRoot;
  }
}

function assertContainedProjectFile(
  fsMod: NodeFsBuiltin,
  pathMod: NodePathBuiltin,
  absRoot: string,
  realRoot: string,
  file: string,
): void {
  if (!isWithinRoot(pathMod, absRoot, file)) {
    throw new Error('Rule path escapes project root');
  }
  assertNotSymlink(fsMod, file);
  if (typeof fsMod.realpathSync === 'function' && fsMod.existsSync(file)) {
    const realFile = fsMod.realpathSync(file);
    if (!isWithinRoot(pathMod, realRoot, realFile)) {
      throw new Error('Rule path escapes project root via symbolic link');
    }
  }
}

interface FirestoreConfigEntry {
  file: string;
  database?: string;
  fromProject?: boolean;
}

interface RtdbConfigEntry {
  file: string;
  instance?: string;
  fromProject?: boolean;
}

interface StorageConfigEntry {
  file: string;
  bucket?: string;
  fromProject?: boolean;
}

interface FirebaseRcTargetConfig {
  readonly hasFirebaseRc: boolean;
  readonly projectId?: string;
  readonly firestoreTargets: Readonly<Record<string, readonly string[]>>;
  readonly databaseTargets: Readonly<Record<string, readonly string[]>>;
  readonly storageTargets: Readonly<Record<string, readonly string[]>>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractStringArrayMap(raw: unknown): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [targetName, rawValues] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rawValues)) continue;
    const items = rawValues.filter(nonEmptyString);
    out[targetName] = items;
  }
  return out;
}

const DEFAULT_RTDB_SUFFIX_RE = /^[a-z0-9-]+-default-rtdb$/i;

function readFirebaseToolsActiveProject(
  builtins: RuleSourceBuiltins,
  absRoot: string,
  realRoot: string,
): string | undefined {
  const { fs: fsMod, path: pathMod, env } = builtins;
  const xdgConfig = env?.XDG_CONFIG_HOME;
  const home = nonEmptyString(env?.HOME) ? env.HOME : builtins.homedir?.();
  let configBase: string | undefined;
  if (nonEmptyString(xdgConfig)) {
    configBase = xdgConfig.trim();
  } else if (nonEmptyString(home)) {
    configBase = pathMod.join(home, '.config');
  }
  if (configBase === undefined) return undefined;
  const storePath = pathMod.join(configBase, 'configstore', 'firebase-tools.json');
  if (!fsMod.existsSync(storePath)) return undefined;
  try {
    const parsed = JSON.parse(fsMod.readFileSync(storePath, 'utf8')) as {
      activeProjects?: unknown;
    };
    const active = parsed.activeProjects;
    if (!active || typeof active !== 'object' || Array.isArray(active)) return undefined;
    const record = active as Record<string, unknown>;
    const resolvedRoot = pathMod.resolve(absRoot);
    const roots = realRoot !== resolvedRoot ? [resolvedRoot, realRoot] : [resolvedRoot];
    for (const start of roots) {
      let current = start;
      while (true) {
        const candidate = record[current];
        if (Object.hasOwn(record, current) && nonEmptyString(candidate)) {
          return candidate.trim();
        }
        const parent = pathMod.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readFirebaseRcTargetConfig(
  builtins: RuleSourceBuiltins,
  absRoot: string,
  realRoot: string,
): FirebaseRcTargetConfig {
  const { fs: fsMod, path: pathMod, env } = builtins;
  const rcPath = pathMod.join(absRoot, '.firebaserc');
  if (!fsMod.existsSync(rcPath)) {
    return {
      hasFirebaseRc: false,
      firestoreTargets: {},
      databaseTargets: {},
      storageTargets: {},
    };
  }
  try {
    assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, rcPath);
    const parsedRc = JSON.parse(fsMod.readFileSync(rcPath, 'utf8')) as {
      projects?: unknown;
      targets?: unknown;
    };
    const aliases: Record<string, string> = {};
    if (parsedRc.projects && typeof parsedRc.projects === 'object' && !Array.isArray(parsedRc.projects)) {
      for (const [alias, proj] of Object.entries(parsedRc.projects as Record<string, unknown>)) {
        if (nonEmptyString(proj)) {
          aliases[alias] = proj.trim();
        }
      }
    }

    const resolveAlias = (candidate: string): string => {
      if (Object.hasOwn(aliases, candidate)) {
        return aliases[candidate]!;
      }
      return candidate;
    };

    let configProject: string | undefined;
    const pyricConfigPath = pathMod.join(absRoot, 'pyric.json');
    if (fsMod.existsSync(pyricConfigPath)) {
      try {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, pyricConfigPath);
        const parsedPyric = JSON.parse(fsMod.readFileSync(pyricConfigPath, 'utf8')) as {
          project?: unknown;
        };
        if (nonEmptyString(parsedPyric.project)) {
          configProject = parsedPyric.project.trim();
        }
      } catch {
        configProject = undefined;
      }
    }

    let projectId: string | undefined;
    const envProject = env?.PYRIC_PROJECT;
    const activeToolsProject = readFirebaseToolsActiveProject(builtins, absRoot, realRoot);
    if (nonEmptyString(envProject)) {
      projectId = resolveAlias(envProject.trim());
    } else if (configProject !== undefined) {
      projectId = resolveAlias(configProject);
    } else if (activeToolsProject !== undefined) {
      projectId = resolveAlias(activeToolsProject);
    } else {
      const aliasEntries = Object.entries(aliases);
      if (aliasEntries.length === 1) {
        projectId = aliasEntries[0]![1];
      } else if (nonEmptyString(aliases.default)) {
        projectId = aliases.default;
      }
    }

    let firestoreTargets: Record<string, readonly string[]> = {};
    let databaseTargets: Record<string, readonly string[]> = {};
    let storageTargets: Record<string, readonly string[]> = {};
    if (
      projectId !== undefined
      && parsedRc.targets
      && typeof parsedRc.targets === 'object'
      && !Array.isArray(parsedRc.targets)
    ) {
      const projTargets = (parsedRc.targets as Record<string, unknown>)[projectId];
      if (projTargets && typeof projTargets === 'object' && !Array.isArray(projTargets)) {
        const record = projTargets as {
          firestore?: unknown;
          database?: unknown;
          storage?: unknown;
        };
        firestoreTargets = extractStringArrayMap(record.firestore);
        databaseTargets = extractStringArrayMap(record.database);
        storageTargets = extractStringArrayMap(record.storage);
      }
    }

    const result: {
      hasFirebaseRc: true;
      projectId?: string;
      firestoreTargets: Readonly<Record<string, readonly string[]>>;
      databaseTargets: Readonly<Record<string, readonly string[]>>;
      storageTargets: Readonly<Record<string, readonly string[]>>;
    } = {
      hasFirebaseRc: true,
      firestoreTargets,
      databaseTargets,
      storageTargets,
    };
    if (projectId !== undefined) {
      result.projectId = projectId;
    }
    return result;
  } catch {
    return {
      hasFirebaseRc: false,
      firestoreTargets: {},
      databaseTargets: {},
      storageTargets: {},
    };
  }
}

function firestoreRulesEntries(
  section: unknown,
  rcConfig: FirebaseRcTargetConfig,
): FirestoreConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: FirestoreConfigEntry[] = [];
  const pushEntry = (file: string, database: string | undefined): void => {
    const normalizedDb = database === '(default)' || database === '' ? undefined : database;
    const key = `${normalizedDb ?? ''}|${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry: FirestoreConfigEntry = { file, fromProject: true };
    if (normalizedDb !== undefined) entry.database = normalizedDb;
    out.push(entry);
  };
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { rules?: unknown; database?: unknown; target?: unknown };
    if (typeof rec.rules !== 'string') continue;
    if (nonEmptyString(rec.target) && rcConfig.hasFirebaseRc) {
      const mapped = rcConfig.firestoreTargets[rec.target] ?? [];
      for (const dbId of mapped) {
        pushEntry(rec.rules, dbId);
      }
      continue;
    }
    let database: string | undefined;
    if (typeof rec.database === 'string' && rec.database.length > 0) {
      database = rec.database;
    }
    pushEntry(rec.rules, database);
  }
  return out;
}

function rtdbRulesEntries(
  section: unknown,
  rcConfig: FirebaseRcTargetConfig,
): RtdbConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: RtdbConfigEntry[] = [];
  const pushEntry = (file: string, instance: string | undefined): void => {
    let normalizedInst = instance;
    if (
      normalizedInst === ''
      || normalizedInst === '(default)'
      || (
        normalizedInst !== undefined
        && (
          isDefaultDatabaseInstance(normalizedInst, rcConfig.projectId)
          || (rcConfig.projectId === undefined && DEFAULT_RTDB_SUFFIX_RE.test(normalizedInst))
        )
      )
    ) {
      normalizedInst = undefined;
    }
    const key = `${normalizedInst ?? ''}|${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry: RtdbConfigEntry = { file, fromProject: true };
    if (normalizedInst !== undefined) entry.instance = normalizedInst;
    out.push(entry);
  };
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { rules?: unknown; instance?: unknown; target?: unknown };
    if (typeof rec.rules !== 'string') continue;
    if (nonEmptyString(rec.target) && rcConfig.hasFirebaseRc) {
      const mapped = rcConfig.databaseTargets[rec.target] ?? [];
      for (const instId of mapped) {
        pushEntry(rec.rules, instId);
      }
      continue;
    }
    let instance: string | undefined;
    if (typeof rec.instance === 'string' && rec.instance.length > 0) {
      instance = rec.instance;
    }
    pushEntry(rec.rules, instance);
  }
  return out;
}

function normalizeBucketName(raw: string): string {
  let trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('gs://')) {
    trimmed = trimmed.slice('gs://'.length);
  }
  return trimmed.replace(/\/+$/g, '');
}

function storageRulesEntries(
  section: unknown,
  rcConfig: FirebaseRcTargetConfig,
): StorageConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: StorageConfigEntry[] = [];
  const pushEntry = (file: string, bucket: string | undefined): void => {
    const normalizedBucket = bucket === undefined ? undefined : normalizeBucketName(bucket);
    const effectiveBucket =
      normalizedBucket === '' || normalizedBucket === '(default)' ? undefined : normalizedBucket;
    const key = `${effectiveBucket ?? ''}|${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entry: StorageConfigEntry = { file, fromProject: true };
    if (effectiveBucket !== undefined) entry.bucket = effectiveBucket;
    out.push(entry);
  };
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { rules?: unknown; bucket?: unknown; target?: unknown };
    if (typeof rec.rules !== 'string') continue;
    if (nonEmptyString(rec.target) && rcConfig.hasFirebaseRc) {
      const mapped = rcConfig.storageTargets[rec.target] ?? [];
      for (const bucketId of mapped) {
        pushEntry(rec.rules, bucketId);
      }
      continue;
    }
    let bucket: string | undefined;
    if (typeof rec.bucket === 'string' && rec.bucket.length > 0) {
      bucket = rec.bucket;
    }
    pushEntry(rec.rules, bucket);
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface BundleRulesSourceOptions {
  readonly filePath?: string;
  readonly rootDir?: string;
  readonly sourceFile?: string;
  readonly targetService?: 'cloud.firestore' | 'firebase.storage';
  readonly modules?: Readonly<Record<string, string>>;
}

function readDiskRelativeModule(
  fsMod: NodeFsBuiltin,
  pathMod: NodePathBuiltin,
  baseDir: string,
  specifier: string,
  absRoot: string | undefined,
  realRoot: string | undefined,
  callerModules: Readonly<Record<string, string>> | undefined,
  visited = new Set<string>(),
): string | null {
  const fromMemory = lookupInMemoryModule(specifier, callerModules);
  const isStdlibAlias = /^\.\/stdlib\/(.+?)(?:\.rules)?$/.test(specifier);
  if (fromMemory !== null && !specifier.startsWith('./') && !specifier.startsWith('../')) {
    return fromMemory;
  }
  if (callerModules !== undefined && lookupInMemoryModule(specifier, callerModules) !== null) {
    const rawMem = lookupInMemoryModule(specifier, callerModules)!;
    const expandedMem = expandBareModuleImports(rawMem, (nested) =>
      lookupInMemoryModule(nested, callerModules),
    );
    return preNormalizeModularSyntax(expandedMem);
  }

  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return fromMemory;
  }

  const fileName = specifier.endsWith('.rules') ? specifier : `${specifier}.rules`;
  const candidate = pathMod.resolve(baseDir, fileName);

  if (absRoot !== undefined) {
    if (!isWithinRoot(pathMod, absRoot, candidate)) {
      throw new Error('Rule path escapes project root');
    }
  }

  if (typeof fsMod.lstatSync === 'function') {
    let stat: { isSymbolicLink(): boolean };
    try {
      stat = fsMod.lstatSync(candidate);
    } catch {
      return isStdlibAlias ? fromMemory : null;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Symbolic links are not followed');
    }
  } else if (!fsMod.existsSync(candidate)) {
    return isStdlibAlias ? fromMemory : null;
  }

  if (
    absRoot !== undefined
    && realRoot !== undefined
    && typeof fsMod.realpathSync === 'function'
  ) {
    const realCandidate = fsMod.realpathSync(candidate);
    if (!isWithinRoot(pathMod, realRoot, realCandidate)) {
      throw new Error('Rule path escapes project root via symbolic link');
    }
  }

  const rawText = fsMod.readFileSync(candidate, 'utf8');
  if (visited.has(candidate)) return preNormalizeModularSyntax(rawText);
  const nextVisited = new Set(visited);
  nextVisited.add(candidate);
  const candidateDir = pathMod.dirname(candidate);
  const expanded = expandBareModuleImports(rawText, (nested) =>
    readDiskRelativeModule(
      fsMod,
      pathMod,
      candidateDir,
      nested,
      absRoot,
      realRoot,
      callerModules,
      nextVisited,
    ),
  );
  return preNormalizeModularSyntax(expanded);
}

/**
 * Bundle a `rules_version = '2+modules'` Firestore or Storage ruleset into a
 * self-contained `rules_version = '2'` source string (resolving stdlib and
 * relative `.rules` module imports). Non-modular sources are returned verbatim.
 */
export function bundleRulesSource(
  source: string,
  options?: BundleRulesSourceOptions,
): string {
  if (!isModularRulesSource(source)) return source;

  let preparedModules: Record<string, string> | undefined;
  if (options?.modules !== undefined) {
    preparedModules = {};
    for (const [key, rawMod] of Object.entries(options.modules)) {
      if (typeof rawMod !== 'string') continue;
      const expandedMod = expandBareModuleImports(rawMod, (spec) =>
        lookupInMemoryModule(spec, options.modules),
      );
      Object.defineProperty(preparedModules, key, {
        value: preNormalizeModularSyntax(expandedMod),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  const builtins = options?.filePath !== undefined ? acquireRuleSourceBuiltins() : null;
  if (builtins !== null && options?.filePath !== undefined) {
    const { fs: fsMod, path: pathMod } = builtins;
    const absFile = pathMod.resolve(options.filePath);
    const baseDir = pathMod.dirname(absFile);
    const absRoot =
      options.rootDir !== undefined ? pathMod.resolve(options.rootDir) : undefined;
    const realRoot =
      absRoot !== undefined ? resolveRealRoot(fsMod, absRoot) : undefined;

    const expandedSource = expandBareModuleImports(source, (spec) =>
      readDiskRelativeModule(
        fsMod,
        pathMod,
        baseDir,
        spec,
        absRoot,
        realRoot,
        options.modules,
      ),
    );
    const preNormalized = preNormalizeModularSyntax(expandedSource);
    const resolveOpts: {
      basePath: string;
      modules?: Record<string, string>;
      sourceFile?: string;
      targetService?: 'cloud.firestore' | 'firebase.storage';
    } = { basePath: baseDir };
    if (preparedModules !== undefined) resolveOpts.modules = preparedModules;
    if (options.sourceFile !== undefined) resolveOpts.sourceFile = options.sourceFile;
    if (options.targetService !== undefined) resolveOpts.targetService = options.targetService;

    const resolved = resolveModulesWithFiles(
      preNormalized,
      (base, modName) =>
        readDiskRelativeModule(
          fsMod,
          pathMod,
          base,
          modName,
          absRoot,
          realRoot,
          options.modules,
        ),
      resolveOpts,
    );
    if (!resolved.success) {
      throw new Error(resolved.error.message);
    }
    return restoreDefaultDbSentinelText(resolved.data.resolved);
  }

  const expandedSource = expandBareModuleImports(source, (spec) =>
    lookupInMemoryModule(spec, preparedModules ?? options?.modules),
  );
  const preNormalized = preNormalizeModularSyntax(expandedSource);
  const browserOpts: {
    modules?: Record<string, string>;
    sourceFile?: string;
    targetService?: 'cloud.firestore' | 'firebase.storage';
  } = {};
  if (preparedModules !== undefined) browserOpts.modules = preparedModules;
  if (options?.sourceFile !== undefined) browserOpts.sourceFile = options.sourceFile;
  if (options?.targetService !== undefined) browserOpts.targetService = options.targetService;

  const resolved = resolveModulesBrowser(preNormalized, browserOpts);
  if (!resolved.success) {
    throw new Error(resolved.error.message);
  }
  return restoreDefaultDbSentinelText(resolved.data.resolved);
}

/**
 * Load rules for an app root. Explicit files win; otherwise `firebase.json`
 * is read. Duplicate files (several RTDB targets sharing one file) load once.
 */
export function loadRuleSources(
  root: string,
  explicit: { firestore?: string[]; rtdb?: string[]; storage?: string[] } = {},
): RuleSources {
  const storageList: StorageRuleSource[] = [];
  const out: RuleSources = { firestore: [], rtdb: [], storage: storageList, problems: [] };
  const builtins = acquireRuleSourceBuiltins();
  if (builtins === null) {
    out.problems.push('loadRuleSources requires a Node.js filesystem runtime.');
    return out;
  }
  const { fs: fsMod, path: pathMod } = builtins;
  const absRoot = pathMod.resolve(root);
  const realRoot = resolveRealRoot(fsMod, absRoot);
  const hasExplicit =
    (explicit.firestore?.length ?? 0) > 0
    || (explicit.rtdb?.length ?? 0) > 0
    || (explicit.storage?.length ?? 0) > 0;
  let firestoreEntries: FirestoreConfigEntry[] = (explicit.firestore ?? []).map((f) => ({
    file: pathMod.resolve(f),
  }));
  let rtdbEntries: RtdbConfigEntry[] = (explicit.rtdb ?? []).map((f) => ({
    file: pathMod.resolve(f),
  }));
  let storageEntries: StorageConfigEntry[] = (explicit.storage ?? []).map((f) => ({
    file: pathMod.resolve(f),
  }));
  if (!hasExplicit) {
    const rcConfig = readFirebaseRcTargetConfig(builtins, absRoot, realRoot);
    const config = pathMod.join(absRoot, 'firebase.json');
    if (fsMod.existsSync(config)) {
      try {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, config);
        const rawConfig = JSON.parse(fsMod.readFileSync(config, 'utf8')) as unknown;
        if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
          throw new Error('firebase.json must contain a JSON object');
        }
        const parsed = rawConfig as {
          firestore?: unknown;
          database?: unknown;
          storage?: unknown;
        };
        if (firestoreEntries.length === 0) {
          firestoreEntries = firestoreRulesEntries(parsed.firestore, rcConfig).map((entry) => {
            const resolved: FirestoreConfigEntry = {
              file: pathMod.resolve(absRoot, entry.file),
              fromProject: true,
            };
            if (entry.database !== undefined) resolved.database = entry.database;
            return resolved;
          });
        }
        if (rtdbEntries.length === 0) {
          rtdbEntries = rtdbRulesEntries(parsed.database, rcConfig).map((entry) => {
            const resolved: RtdbConfigEntry = {
              file: pathMod.resolve(absRoot, entry.file),
              fromProject: true,
            };
            if (entry.instance !== undefined) resolved.instance = entry.instance;
            return resolved;
          });
        }
        if (storageEntries.length === 0) {
          storageEntries = storageRulesEntries(parsed.storage, rcConfig).map((entry) => {
            const resolved: StorageConfigEntry = {
              file: pathMod.resolve(absRoot, entry.file),
              fromProject: true,
            };
            if (entry.bucket !== undefined) resolved.bucket = entry.bucket;
            return resolved;
          });
        }
      } catch (e) {
        out.problems.push(`firebase.json: ${errorText(e)}`);
      }
    }
  }
  for (const item of firestoreEntries) {
    try {
      if (item.fromProject) {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, item.file);
      } else {
        assertNotSymlink(fsMod, item.file);
      }
      const sourceLabel = rel(pathMod, absRoot, item.file);
      const rawText = fsMod.readFileSync(item.file, 'utf8');
      const bundleOpts: {
        filePath: string;
        rootDir?: string;
        sourceFile: string;
        targetService: 'cloud.firestore';
      } = {
        filePath: item.file,
        sourceFile: sourceLabel,
        targetService: 'cloud.firestore',
      };
      if (item.fromProject) bundleOpts.rootDir = absRoot;
      const bundledText = bundleRulesSource(rawText, bundleOpts);
      if (!isHeaderOnlyRulesVersionStub(bundledText)) {
        const syntax = validateRulesSourceSyntax(bundledText, 'cloud.firestore', {
          sourceFile: sourceLabel,
          targetService: 'cloud.firestore',
        });
        if (!syntax.ok) {
          throw new Error(syntax.message);
        }
      }
      const loaded: FirestoreRuleSource = {
        source: sourceLabel,
        text: bundledText,
      };
      if (item.database !== undefined) loaded.database = item.database;
      out.firestore.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  for (const item of rtdbEntries) {
    try {
      if (item.fromProject) {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, item.file);
      } else {
        assertNotSymlink(fsMod, item.file);
      }
      const loaded: RtdbRuleSource = {
        source: rel(pathMod, absRoot, item.file),
        json: parseRtdbRulesText(fsMod.readFileSync(item.file, 'utf8')),
      };
      if (item.instance !== undefined) loaded.instance = item.instance;
      out.rtdb.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  for (const item of storageEntries) {
    try {
      if (item.fromProject) {
        assertContainedProjectFile(fsMod, pathMod, absRoot, realRoot, item.file);
      } else {
        assertNotSymlink(fsMod, item.file);
      }
      const sourceLabel = rel(pathMod, absRoot, item.file);
      const rawText = fsMod.readFileSync(item.file, 'utf8');
      const bundleOpts: {
        filePath: string;
        rootDir?: string;
        sourceFile: string;
        targetService: 'firebase.storage';
      } = {
        filePath: item.file,
        sourceFile: sourceLabel,
        targetService: 'firebase.storage',
      };
      if (item.fromProject) bundleOpts.rootDir = absRoot;
      const bundledText = bundleRulesSource(rawText, bundleOpts);
      if (!isHeaderOnlyRulesVersionStub(bundledText)) {
        const syntax = validateRulesSourceSyntax(bundledText, 'firebase.storage', {
          sourceFile: sourceLabel,
          targetService: 'firebase.storage',
        });
        if (!syntax.ok) {
          throw new Error(syntax.message);
        }
      }
      const loaded: StorageRuleSource = {
        source: sourceLabel,
        text: bundledText,
      };
      if (item.bucket !== undefined) loaded.bucket = item.bucket;
      storageList.push(loaded);
    } catch (e) {
      out.problems.push(`${rel(pathMod, absRoot, item.file)}: ${errorText(e)}`);
    }
  }
  return out;
}
