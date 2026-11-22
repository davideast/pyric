/**
 * Per-database Firestore project rules loader, `.firebaserc` deploy-target
 * mapping, startup notices, and synchronous in-process bridge loader (#1319,
 * ADR-0021 Decisions 3 & 6).
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { LocalSandbox } from 'pyric/sandbox';
import { declareFirestoreDatabase, setRules } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import {
  DEFAULT_FIRESTORE_DATABASE,
  firestoreRulesConfig,
  invalidFirestoreDatabaseWarnings,
  isValidFirestoreDatabaseConfigId,
  unservedFirestoreDatabaseWarnings,
  type FirestoreRulesConfig,
} from 'pyric/sandbox/internal';
import { readFirebaseRcSync, type FirebaseJson, type FirebaseRc } from '../cli/firebase-json.js';
import {
  describeFirebaseProject,
  FIREBASE_PROJECT_FIXES,
  FIREBASE_PROJECT_SOURCES_TRIED,
  type FirebaseProjectResolution,
} from '../cli/firebase-project.js';
import {
  firestoreRulesInForce,
  loadFirestoreRules,
  rememberRefusedFirestoreRules,
} from '../bridge/surface/firestore-rules-load.js';
import {
  MODULAR_SOURCE,
  prepareProjectRules,
  resolveProjectModules,
  rulesHashOf,
  type LoadedRules,
} from './rules.js';

export interface FirestoreRulesProject extends FirebaseProjectResolution {
  readRc?: () => FirebaseRc | null;
}

/** One Firestore database entry from `firebase.json` (with or without a rules file). */
export interface FirestoreRulesTarget {
  database: string;
  /** Absolute path of the rules file, when the entry deploys rules. */
  path?: string;
  label: string;
  configured: boolean;
}

/** A Firestore deploy target no `.firebaserc` mapping resolved at startup. */
export interface PendingFirestoreRulesTarget {
  target: string;
  label: string;
  /** Absolute path of the rules file, when the target deploys rules. */
  path?: string;
  /** Valid database ids `.firebaserc` maps the target to, keyed by project id. */
  databasesByProject: Record<string, string[]>;
  reason: string;
}

interface FirestoreRulesTargets {
  targets: FirestoreRulesTarget[];
  pending: PendingFirestoreRulesTarget[];
  warnings: string[];
}

export interface LoadedFirestoreDatabaseRules {
  database: string;
  rules: string | null;
  rulesHash: string | null;
  sourcePath: string | null;
  moduleFiles: string[];
}

export interface LoadedPendingFirestoreTarget extends PendingFirestoreRulesTarget {
  rules: string | null;
  rulesHash: string | null;
  moduleFiles: string[];
}

export interface LoadedProjectFirestoreRules extends LoadedRules, FirestoreRulesTargets {
  /** Every valid named database id declared in `firebase.json`. */
  declared: ReadonlySet<string>;
  /** Loaded state per database id (including `(default)` when present). */
  databases: Map<string, LoadedFirestoreDatabaseRules>;
  pending: LoadedPendingFirestoreTarget[];
}

function projectFilePath(cwd: string, file: string): string {
  if (isAbsolute(file)) {
    return file;
  }
  return join(cwd, file);
}

function relativeToProject(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel;
  }
  return file;
}

function firestoreTargetMappings(rc: FirebaseRc | null, target: string): Record<string, string[]> {
  const mappings: Record<string, string[]> = {};
  for (const [projectId, types] of Object.entries(rc?.targets ?? {})) {
    const names = types?.firestore?.[target];
    if (!Array.isArray(names) || names.length === 0) {
      continue;
    }
    const valid = names.filter(
      (id): id is string =>
        typeof id === 'string' && id !== '' && isValidFirestoreDatabaseConfigId(id),
    );
    if (valid.length > 0) {
      mappings[projectId] = valid;
    }
  }
  return mappings;
}

function firestoreDatabaseLabel(database?: string, target?: string): string {
  if (target !== undefined) {
    return `deploy target "${target}"`;
  }
  if (database === undefined || database === DEFAULT_FIRESTORE_DATABASE) {
    return 'database "(default)"';
  }
  return `database "${database}"`;
}

export function firestoreDatabaseSuffix(
  database?: string,
  target?: string,
  joiner = ' for',
): string {
  const isDefault =
    (database === undefined || database === DEFAULT_FIRESTORE_DATABASE) && target === undefined;
  if (isDefault) {
    return '';
  }
  return `${joiner} ${firestoreDatabaseLabel(database, target)}`;
}

const WARN_GLYPH = String.fromCharCode(0x26a0);
const RELOAD_GLYPH = String.fromCharCode(0x21bb);
const ARROW_GLYPH = String.fromCharCode(0x2192);
const CHECK_GLYPH = String.fromCharCode(0x2714);
const BULLET_GLYPH = String.fromCharCode(0x2022);
const EM_DASH_GLYPH = String.fromCharCode(0x2014);

export function formatUnresolvedFirestoreTargets(
  pending: readonly PendingFirestoreRulesTarget[],
  policy: 'allow' | 'deny',
): string {
  let access = 'stay missing/undeclared';
  if (policy === 'allow') {
    access = 'stay undeclared (and open in permissive mode once resolved without rules)';
  }
  const lines = pending.map(
    (target) =>
      `  ${WARN_GLYPH} Firestore deploy target "${target.target}" (${target.label}) is unresolved: ${target.reason}.`,
  );
  lines.push(
    `    Tried ${FIREBASE_PROJECT_SOURCES_TRIED}.`,
    `    Until a project maps the target, its databases ${access}. When the page's app config names a project .firebaserc maps the target for, its databases and rules apply then.`,
    `    To set the project: ${FIREBASE_PROJECT_FIXES}.`,
  );
  return lines.join('\n');
}

function formatFirestoreReloadedNote(
  namedSuffix: string,
  rulesHash: string,
  clients: number,
  verifyHint: string,
): string {
  return `  ${RELOAD_GLYPH} rules reloaded${namedSuffix} (hash ${rulesHash}) ${ARROW_GLYPH} ${String(clients)} page(s)${verifyHint}`;
}

function formatFirestoreReloadRejectedNote(
  namedSuffix: string,
  errorMessage: string,
): string {
  return `  ${WARN_GLYPH} rules NOT reloaded${namedSuffix} (last-good stays live): ${errorMessage}`;
}

export function formatFirestoreReloadNotes(
  results: ReadonlyArray<{
    database?: string;
    target?: string;
    result:
      | { kind: 'reloaded'; rulesHash: string; clients: number; fixtureCheck?: { ran: number; lines: string[] } }
      | { kind: 'rejected'; error: Error }
      | { kind: 'not-configured' }
      | { kind: 'removed'; policy: 'allow' | 'deny' };
  }>,
  verifyHint: string,
): string[] {
  const lines: string[] = [];
  for (const { database, target, result } of results) {
    const named = firestoreDatabaseSuffix(database, target);
    if (result.kind === 'reloaded') {
      lines.push(formatFirestoreReloadedNote(named, result.rulesHash, result.clients, verifyHint));
      if (result.fixtureCheck !== undefined && result.fixtureCheck.ran > 0) {
        lines.push(...result.fixtureCheck.lines);
      }
    } else if (result.kind === 'rejected') {
      lines.push(formatFirestoreReloadRejectedNote(named, result.error.message));
    }
  }
  return lines;
}

export function formatFirestoreWatcherErrorNote(message: string): string {
  return `  ${WARN_GLYPH} rules watcher failed (hot reload off): ${message}`;
}

export function formatStartupFirestoreRulesLines(options: {
  hasDefaultRules: boolean;
  defaultSourcePath: string | null;
  defaultHash: string | null;
  rulesTarget: string;
  namedDatabases: ReadonlyArray<{ database: string; sourcePath: string | null; hash: string | null }>;
  permissive: boolean;
}): string[] {
  const lines: string[] = [];
  if (options.hasDefaultRules) {
    lines.push(
      `${CHECK_GLYPH} rules    ${options.defaultSourcePath} ${ARROW_GLYPH} deployed to the ${options.rulesTarget} (hash ${options.defaultHash})`,
    );
  } else if (options.namedDatabases.length === 0) {
    lines.push(
      `${BULLET_GLYPH} rules    no firestore.rules ${EM_DASH_GLYPH} sandbox runs with default rules`,
    );
  }
  for (const loaded of options.namedDatabases) {
    if (loaded.sourcePath !== null && loaded.hash !== null) {
      lines.push(
        `${CHECK_GLYPH} rules    ${loaded.sourcePath} ${ARROW_GLYPH} deployed to Firestore database ${loaded.database} (hash ${loaded.hash})`,
      );
    } else {
      let accessLabel = 'locked';
      if (options.permissive) {
        accessLabel = 'open (permissive mode)';
      }
      lines.push(
        `${BULLET_GLYPH} rules    Firestore database ${loaded.database} declared with no rules file (${accessLabel})`,
      );
    }
  }
  return lines;
}

function firestoreRulesTargets(
  cwd: string,
  config: FirebaseJson | null,
  project: FirestoreRulesProject = {},
): FirestoreRulesTargets {
  let rc: FirebaseRc | null | undefined;
  const readRc = (): FirebaseRc | null => {
    if (rc === undefined) {
      if (project.readRc !== undefined) {
        rc = project.readRc();
      } else {
        rc = readFirebaseRcSync(cwd);
      }
    }
    return rc;
  };
  const projectId = project.projectId;
  let resolved: FirestoreRulesConfig;
  try {
    resolved = firestoreRulesConfig(config?.firestore, {
      targetDatabases: (target) => {
        if (projectId === undefined) {
          return [];
        }
        return readRc()?.targets?.[projectId]?.firestore?.[target] ?? [];
      },
      resolveFile: (file) => projectFilePath(cwd, file),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`pyric sandbox: ${detail}`);
  }

  const warnings = invalidFirestoreDatabaseWarnings(resolved, (file) =>
    relativeToProject(cwd, file),
  );
  const targets: FirestoreRulesTarget[] = [];
  for (const entry of resolved.databases) {
    if (!isValidFirestoreDatabaseConfigId(entry.database)) {
      continue;
    }
    const item: FirestoreRulesTarget = {
      database: entry.database,
      label: entry.label,
      configured: entry.configured,
    };
    if (entry.rulesFile !== undefined) {
      item.path = entry.rulesFile;
    }
    targets.push(item);
  }

  let unresolvedReason = 'no Firebase project is set';
  if (projectId !== undefined) {
    unresolvedReason = `project ${describeFirebaseProject(project)} has no .firebaserc mapping for it (firebase target:apply firestore <target> <database>)`;
  }
  const pending: PendingFirestoreRulesTarget[] = resolved.unresolved.map((entry) => {
    let reason = unresolvedReason;
    if (projectId !== undefined) {
      reason = `project ${describeFirebaseProject(project)} has no .firebaserc mapping for it (firebase target:apply firestore ${entry.target} <database>)`;
    }
    const item: PendingFirestoreRulesTarget = {
      target: entry.target,
      label: entry.label,
      databasesByProject: firestoreTargetMappings(readRc(), entry.target),
      reason,
    };
    if (entry.rulesFile !== undefined) {
      item.path = entry.rulesFile;
    }
    return item;
  });

  return { targets, pending, warnings };
}

export async function loadFirestoreRulesTarget(
  target: FirestoreRulesTarget,
): Promise<LoadedFirestoreDatabaseRules> {
  if (target.path === undefined) {
    return {
      database: target.database,
      rules: null,
      rulesHash: null,
      sourcePath: null,
      moduleFiles: [],
    };
  }
  let raw: string;
  try {
    raw = await readFile(target.path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (target.configured) {
        throw new Error(
          `pyric sandbox: ${target.label} points Firestore rules at ${target.path}, but it does not exist.`,
        );
      }
      return {
        database: target.database,
        rules: null,
        rulesHash: null,
        sourcePath: null,
        moduleFiles: [],
      };
    }
    throw e;
  }
  const { rules, moduleFiles } = prepareProjectRules(raw, target.path);
  return {
    database: target.database,
    rules,
    rulesHash: rulesHashOf(rules),
    sourcePath: target.path,
    moduleFiles,
  };
}

export async function loadPendingFirestoreTarget(
  target: PendingFirestoreRulesTarget,
): Promise<LoadedPendingFirestoreTarget> {
  if (target.path === undefined) {
    return { ...target, rules: null, rulesHash: null, moduleFiles: [] };
  }
  let raw: string;
  try {
    raw = await readFile(target.path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...target, rules: null, rulesHash: null, moduleFiles: [] };
    }
    throw e;
  }
  const { rules, moduleFiles } = prepareProjectRules(raw, target.path);
  return {
    ...target,
    rules,
    rulesHash: rulesHashOf(rules),
    moduleFiles,
  };
}

export async function loadProjectFirestoreRules(
  cwd: string,
  config: FirebaseJson | null,
  project: FirestoreRulesProject = {},
): Promise<LoadedProjectFirestoreRules> {
  const { targets, pending, warnings } = firestoreRulesTargets(cwd, config, project);
  const databases = new Map<string, LoadedFirestoreDatabaseRules>();
  const declared = new Set<string>();
  const preparedByPath = new Map<string, { rules: string; rulesHash: string; moduleFiles: string[] }>();

  for (const target of targets) {
    if (target.database !== DEFAULT_FIRESTORE_DATABASE) {
      declared.add(target.database);
    }
    if (target.path !== undefined && preparedByPath.has(target.path)) {
      const cached = preparedByPath.get(target.path)!;
      databases.set(target.database, {
        database: target.database,
        rules: cached.rules,
        rulesHash: cached.rulesHash,
        sourcePath: target.path,
        moduleFiles: [...cached.moduleFiles],
      });
      continue;
    }
    const loaded = await loadFirestoreRulesTarget(target);
    if (loaded.rules !== null && loaded.rulesHash !== null && loaded.sourcePath !== null) {
      preparedByPath.set(loaded.sourcePath, {
        rules: loaded.rules,
        rulesHash: loaded.rulesHash,
        moduleFiles: loaded.moduleFiles,
      });
    }
    databases.set(target.database, loaded);
  }

  const loadedPending: LoadedPendingFirestoreTarget[] = [];
  for (const target of pending) {
    loadedPending.push(await loadPendingFirestoreTarget(target));
  }

  const defaultLoaded = databases.get(DEFAULT_FIRESTORE_DATABASE);
  return {
    targets,
    pending: loadedPending,
    warnings,
    declared,
    databases,
    rules: defaultLoaded?.rules ?? null,
    rulesHash: defaultLoaded?.rulesHash ?? null,
    sourcePath: defaultLoaded?.sourcePath ?? null,
    moduleFiles: defaultLoaded?.moduleFiles ?? [],
  };
}

export interface PersistedFirestoreRulesEntry {
  active: string;
  diskAtSave: string | null;
}

/**
 * Synchronously load `(default)` and named-database Firestore rules from
 * `<cwd>/firebase.json` + `.firebaserc` into `sandbox` for the in-process MCP
 * server (`in-process.ts`), preserving persisted runtime rules on `(default)`
 * when disk rules have not changed since save.
 */
export function loadInProcessFirestoreProjectRules(
  sandbox: LocalSandbox,
  cwd: string,
  config: FirebaseJson | null,
  persistedDefault: PersistedFirestoreRulesEntry | undefined,
  inProcessStatePath: string,
  onWarning: (message: string) => void,
): { path: string; refused: string | null } | null {
  const projectId = readFirebaseRcSync(cwd)?.projects?.default;
  const projectOpts: FirestoreRulesConfigOptionsForSync = {};
  if (projectId !== undefined) {
    projectOpts.projectId = projectId;
  }
  const resolved = firestoreRulesConfig(config?.firestore, {
    targetDatabases: (target) => {
      if (projectOpts.projectId === undefined) {
        return [];
      }
      return readFirebaseRcSync(cwd)?.targets?.[projectOpts.projectId]?.firestore?.[target] ?? [];
    },
    resolveFile: (file) => projectFilePath(cwd, file),
  });
  for (const warning of unservedFirestoreDatabaseWarnings(resolved, (file) => relativeToProject(cwd, file))) {
    onWarning(warning);
  }

  let defaultResult: { path: string; refused: string | null } | null = null;
  let sawDefaultEntry = false;

  for (const entry of resolved.databases) {
    if (!isValidFirestoreDatabaseConfigId(entry.database)) {
      continue;
    }
    const isDefault = entry.database === DEFAULT_FIRESTORE_DATABASE;
    if (isDefault) {
      sawDefaultEntry = true;
    } else {
      declareFirestoreDatabase(sandbox, entry.database, { locked: true });
    }
    const path = entry.rulesFile;
    if (path === undefined || !existsSync(path)) {
      if (entry.configured && path !== undefined) {
        onWarning(`${entry.label} points Firestore rules at ${path}, but it does not exist.`);
      }
      if (isDefault && persistedDefault !== undefined && persistedDefault.active !== '' && persistedDefault.diskAtSave === null) {
        defaultResult = {
          path: path ?? inProcessStatePath,
          refused: loadFirestoreRules(sandbox, persistedDefault.active),
        };
      }
      continue;
    }
    const raw = readFileSync(path, 'utf8');
    let candidate = raw;
    if (MODULAR_SOURCE.test(raw)) {
      const modRes = resolveProjectModules(raw, path, path, 'cloud.firestore').result;
      if (!modRes.success) {
        if (isDefault) {
          rememberRefusedFirestoreRules(sandbox, raw);
          defaultResult = { path, refused: `Firestore rules module resolution failed: ${modRes.error.message}` };
        } else {
          onWarning(`${entry.label} (${path}) module resolution failed: ${modRes.error.message}`);
        }
        continue;
      }
      candidate = modRes.data.resolved;
    }
    if (isDefault) {
      if (
        rulesSourceRejection(candidate) === null &&
        persistedDefault !== undefined &&
        persistedDefault.active !== '' &&
        persistedDefault.diskAtSave === candidate
      ) {
        defaultResult = { path, refused: loadFirestoreRules(sandbox, persistedDefault.active) };
        continue;
      }
      const refused = loadFirestoreRules(sandbox, candidate);
      if (refused !== null && candidate !== raw) {
        rememberRefusedFirestoreRules(sandbox, raw);
      }
      defaultResult = { path, refused };
    } else {
      const rejection = rulesSourceRejection(candidate);
      if (rejection !== null) {
        onWarning(`${entry.label} (${path}) rejected: Firestore ${rejection.message}`);
        continue;
      }
      setRules(sandbox, candidate, entry.database);
    }
  }

  if (!sawDefaultEntry && persistedDefault !== undefined && persistedDefault.active !== '' && persistedDefault.diskAtSave === null) {
    defaultResult = {
      path: inProcessStatePath,
      refused: loadFirestoreRules(sandbox, persistedDefault.active),
    };
  }

  void firestoreRulesInForce;
  return defaultResult;
}

interface FirestoreRulesConfigOptionsForSync {
  projectId?: string;
}
