/**
 * `.firebaserc` project/target resolution and `firebase.json` service rule
 * entry extraction for `rule-sources.ts`.
 */
import { isDefaultDatabaseInstance } from '@pyric/rules/internal/rtdb';
import {
  assertContainedProjectFile,
  type RuleSourceBuiltins,
} from './rule-source-bundler.js';

export interface FirestoreConfigEntry {
  file: string;
  database?: string;
  fromProject?: boolean;
}

export interface RtdbConfigEntry {
  file: string;
  instance?: string;
  fromProject?: boolean;
}

export interface StorageConfigEntry {
  file: string;
  bucket?: string;
  fromProject?: boolean;
}

export interface FirebaseRcTargetConfig {
  readonly hasFirebaseRc: boolean;
  readonly projectId?: string;
  readonly firestoreTargets: Readonly<Record<string, readonly string[]>>;
  readonly databaseTargets: Readonly<Record<string, readonly string[]>>;
  readonly storageTargets: Readonly<Record<string, readonly string[]>>;
}

const DEFAULT_RTDB_SUFFIX_RE = /^[a-z0-9-]+-default-rtdb$/i;

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

function readFirebaseToolsActiveProject(
  builtins: RuleSourceBuiltins,
  absRoot: string,
  realRoot: string,
): string | undefined {
  const { fs: fsMod, path: pathMod, env } = builtins;
  const xdgConfig = env?.XDG_CONFIG_HOME;
  let home: string | undefined;
  if (nonEmptyString(env?.HOME)) {
    home = env.HOME;
  } else {
    home = builtins.homedir?.();
  }
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
    let roots = [resolvedRoot];
    if (realRoot !== resolvedRoot) {
      roots = [resolvedRoot, realRoot];
    }
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

export function readFirebaseRcTargetConfig(
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

export function firestoreRulesEntries(
  section: unknown,
  rcConfig: FirebaseRcTargetConfig,
): FirestoreConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: FirestoreConfigEntry[] = [];
  const pushEntry = (file: string, database: string | undefined): void => {
    let normalizedDb = database;
    if (database === '(default)' || database === '') {
      normalizedDb = undefined;
    }
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

export function rtdbRulesEntries(
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

export function storageRulesEntries(
  section: unknown,
  rcConfig: FirebaseRcTargetConfig,
): StorageConfigEntry[] {
  let entries: unknown[] = [section];
  if (Array.isArray(section)) entries = section;
  const seen = new Set<string>();
  const out: StorageConfigEntry[] = [];
  const pushEntry = (file: string, bucket: string | undefined): void => {
    let normalizedBucket: string | undefined;
    if (bucket !== undefined) {
      normalizedBucket = normalizeBucketName(bucket);
    }
    let effectiveBucket = normalizedBucket;
    if (normalizedBucket === '' || normalizedBucket === '(default)') {
      effectiveBucket = undefined;
    }
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
