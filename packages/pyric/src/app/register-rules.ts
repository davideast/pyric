/**
 * Loads the rules a project's `firebase.json` declares into the in-process
 * sandbox that `pyric/app/register` prepares for `PYRIC_SANDBOX=local`:
 * Firestore, every Realtime Database instance, and Storage.
 *
 * Each service loads on its own. A service whose rules cannot be read or are
 * refused writes one stderr line and keeps the default policy, deny; the
 * other services still load.
 *
 * Deploy targets across Firestore, Realtime Database, and Storage resolve
 * against the same Firebase project selection (`PYRIC_PROJECT`, `pyric.json`,
 * `firebase use` configstore, sole `.firebaserc` alias, else `.firebaserc`
 * `projects.default`, #1454) via `selectFirebaseProject`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { LocalSandbox } from 'pyric/sandbox';
import {
  declareFirestoreDatabase,
  setRules as setFirestoreRules,
} from 'pyric/sandbox/firestore';
import { setRules as setDatabaseRules, toStrictRulesJson } from 'pyric/sandbox/database';
import { getDatabase } from 'pyric/database';
import { getStorageSandbox } from 'pyric/storage';
import { deployStorageBucketRules, lockUndeployedStorageBuckets } from 'pyric/storage/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import {
  DEFAULT_DATABASE_RULES_FILE,
  DEFAULT_FIRESTORE_DATABASE,
  firestoreRulesConfig,
  isValidFirestoreDatabaseConfigId,
  storageRulesConfig,
  unservedFirestoreDatabaseWarnings,
} from 'pyric/sandbox/internal';
import { loadFirebaseJsonRules } from '@pyric/rules/internal';
import {
  parseFirebaseToolsActiveProjects,
  parsePyricConfigProject,
  selectFirebaseProject,
  type FirebaseToolsActiveLookup,
} from '../sandbox/internal/firebase-project.js';

interface RulesEntry {
  rules?: unknown;
}

interface FirebaseJson {
  firestore?: unknown;
  database?: unknown;
  storage?: unknown;
}

interface FirebaseRc {
  projects?: Record<string, unknown>;
  targets?: Record<
    string,
    { firestore?: Record<string, unknown>; storage?: Record<string, unknown> } | undefined
  >;
}

const PREFIX = 'pyric/app/register';

function report(file: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${PREFIX}: could not load ${file}: ${reason}\n`);
}

function readFirebaseRc(projectDir: string): FirebaseRc | null {
  const path = resolve(projectDir, '.firebaserc');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as FirebaseRc;
}

function configstorePath(env: NodeJS.ProcessEnv): string {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, 'configstore', 'firebase-tools.json');
  }
  let home = homedir();
  if (typeof env.HOME === 'string' && env.HOME.length > 0) {
    home = env.HOME;
  }
  return join(home, '.config', 'configstore', 'firebase-tools.json');
}

function ancestorChain(start: string): string[] {
  const chain: string[] = [];
  let dir = start;
  for (;;) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function readActiveLookup(projectDir: string, env: NodeJS.ProcessEnv): FirebaseToolsActiveLookup | null {
  const storePath = configstorePath(env);
  if (!existsSync(storePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(storePath, 'utf8');
  } catch (error) {
    if (isFilesystemError(error)) return null;
    throw error;
  }
  const activeProjects = parseFirebaseToolsActiveProjects(raw);
  if (activeProjects === null) return null;
  const resolvedStart = resolve(projectDir);
  const chains: string[][] = [ancestorChain(resolvedStart)];
  if (existsSync(projectDir)) {
    try {
      const realStart = realpathSync(projectDir);
      if (realStart !== resolvedStart) chains.push(ancestorChain(realStart));
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
    }
  }
  return { activeProjects, ancestorChains: chains };
}

function readPyricConfigProject(projectDir: string): string | undefined {
  const path = resolve(projectDir, 'pyric.json');
  if (!existsSync(path)) return undefined;
  try {
    return parsePyricConfigProject(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isFilesystemError(error)) return undefined;
    throw error;
  }
}

function resolveRegisterProject(projectDir: string, readRc: () => FirebaseRc | null): string | undefined {
  return selectFirebaseProject({
    envProject: process.env.PYRIC_PROJECT,
    readConfigProject: () => readPyricConfigProject(projectDir),
    readRc,
    readActiveLookup: () => readActiveLookup(projectDir, process.env),
  }).projectId;
}

/** Load every rules file `<projectDir>/firebase.json` declares into `sandbox`. */
export function loadProjectRules(sandbox: LocalSandbox, projectDir: string): void {
  const firebaseJsonPath = resolve(projectDir, 'firebase.json');
  if (!existsSync(firebaseJsonPath)) return;
  let config: FirebaseJson;
  try {
    config = JSON.parse(readFileSync(firebaseJsonPath, 'utf8')) as FirebaseJson;
  } catch (error) {
    report('firebase.json', error);
    return;
  }
  let cachedRc: FirebaseRc | null | undefined;
  let rcError: unknown;
  const readRcMemo = (): FirebaseRc | null => {
    if (rcError !== undefined) throw rcError;
    if (cachedRc === undefined) {
      try {
        cachedRc = readFirebaseRc(projectDir);
      } catch (err) {
        rcError = err;
        throw err;
      }
    }
    return cachedRc;
  };
  const projectId = resolveRegisterProject(projectDir, readRcMemo);
  loadFirestoreRules(sandbox, projectDir, config, projectId, readRcMemo);
  loadDatabaseRules(sandbox, projectDir, firebaseJsonPath, config, projectId);
  loadStorageRules(sandbox, projectDir, config, projectId, readRcMemo);
}

/** The rules file a service entry names, read relative to the project, or null when it names none. */
function readDeclaredRules(
  projectDir: string,
  entry: RulesEntry | undefined,
): { file: string; source: string } | null {
  const file = entry?.rules;
  if (typeof file !== 'string' || file === '') return null;
  const path = resolve(projectDir, file);
  if (!existsSync(path)) throw new Error(`firebase.json names ${file}, but ${path} does not exist`);
  return { file, source: readFileSync(path, 'utf8') };
}

function targetNames(
  rc: FirebaseRc | null,
  projectId: string | undefined,
  service: 'firestore' | 'storage',
  target: string,
): unknown {
  if (projectId === undefined) return undefined;
  return rc?.targets?.[projectId]?.[service]?.[target];
}

function loadFirestoreRules(
  sandbox: LocalSandbox,
  projectDir: string,
  config: FirebaseJson,
  projectId: string | undefined,
  readRc: () => FirebaseRc | null,
): void {
  let databases: ReturnType<typeof firestoreRulesConfig>;
  try {
    databases = firestoreRulesConfig(config.firestore, {
      targetDatabases: (target) => targetNames(readRc(), projectId, 'firestore', target),
    });
  } catch (error) {
    report('firestore.rules', error);
    return;
  }
  for (const warning of unservedFirestoreDatabaseWarnings(databases)) {
    process.stderr.write(`${PREFIX}: ${warning}\n`);
  }
  for (const entry of databases.databases) {
    if (!isValidFirestoreDatabaseConfigId(entry.database)) {
      continue;
    }
    const isDefault = entry.database === DEFAULT_FIRESTORE_DATABASE;
    if (!isDefault) {
      declareFirestoreDatabase(sandbox, entry.database, { locked: true });
    }
    if (!entry.configured || entry.rulesFile === undefined) {
      continue;
    }
    try {
      const declared = readDeclaredRules(projectDir, { rules: entry.rulesFile });
      if (declared !== null) {
        let targetDb: string | undefined;
        if (!isDefault) {
          targetDb = entry.database;
        }
        setFirestoreRules(sandbox, declared.source, targetDb);
      }
    } catch (error) {
      let label = entry.rulesFile;
      if (!isDefault) {
        label = `${entry.rulesFile} for Firestore database "${entry.database}"`;
      }
      report(label, error);
    }
  }
}

function loadDatabaseRules(
  sandbox: LocalSandbox,
  projectDir: string,
  firebaseJsonPath: string,
  config: FirebaseJson,
  projectId: string | undefined,
): void {
  const declaresNoDatabase =
    config.database === undefined && !existsSync(resolve(projectDir, DEFAULT_DATABASE_RULES_FILE));
  if (declaresNoDatabase) return;
  try {
    const rtdbOpts: { projectId?: string } = {};
    if (projectId !== undefined) {
      rtdbOpts.projectId = projectId;
    }
    const loaded = loadFirebaseJsonRules(firebaseJsonPath, rtdbOpts);
    for (const file of loaded.files) {
      const rules = JSON.parse(toStrictRulesJson(file.text)) as { rules: Record<string, unknown> };
      const rejection = rtdbRulesSourceRejection(rules);
      if (rejection !== null) throw new Error(`${file.path}: ${rejection.message}`);
      for (const instance of file.instances) {
        const target = instance === loaded.defaultInstance ? sandbox : getDatabase(sandbox, instance);
        setDatabaseRules(target, rules);
      }
    }
  } catch (error) {
    report('Realtime Database rules', error);
  }
}

function loadStorageRules(
  sandbox: LocalSandbox,
  projectDir: string,
  config: FirebaseJson,
  projectId: string | undefined,
  readRc: () => FirebaseRc | null,
): void {
  if (config.storage === undefined) return;
  let resolved: ReturnType<typeof storageRulesConfig>;
  try {
    resolved = storageRulesConfig(config.storage, {
      targetBuckets: (target) => targetNames(readRc(), projectId, 'storage', target),
    });
  } catch (error) {
    report('storage.rules', error);
    return;
  }
  lockUndeployedStorageBuckets(sandbox);
  for (const pending of resolved.unresolved) {
    process.stderr.write(
      `${PREFIX}: Storage deploy target "${pending.target}" (${pending.label}) maps to no bucket in .firebaserc, so its rules are not loaded and its buckets stay locked.\n`,
    );
  }
  const defaultRules = resolved.defaultRules;
  if (defaultRules?.configured === true) {
    try {
      const declared = readDeclaredRules(projectDir, { rules: defaultRules.file });
      if (declared !== null) getStorageSandbox(sandbox, { rules: declared.source });
    } catch (error) {
      report('storage.rules', error);
    }
  }
  for (const target of resolved.buckets) {
    try {
      const declared = readDeclaredRules(projectDir, { rules: target.file });
      if (declared !== null) deployStorageBucketRules(sandbox, target.bucket, declared.source);
    } catch (error) {
      report(`${target.file} for Storage bucket "${target.bucket}"`, error);
    }
  }
}
