/**
 * Loads the rules a project's `firebase.json` declares into the in-process
 * sandbox that `pyric/app/register` prepares for `PYRIC_SANDBOX=local`:
 * Firestore, every Realtime Database instance, and Storage.
 *
 * Each service loads on its own. A service whose rules cannot be read or are
 * refused writes one stderr line and keeps the default policy, deny; the
 * other services still load.
 *
 * Firestore rules are the `(default)` database's, resolved as `firebase
 * deploy` resolves the object or array `firestore` form. Each named database
 * and unresolved deploy target gets one stderr warning, since only
 * `(default)` is served.
 *
 * Realtime Database rules resolve through the loader behind
 * `rtdbRules.fromFirebaseJson`, which resolves instances and deploy targets
 * as `firebase deploy` does, with the project from `.firebaserc`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocalSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { setRules as setDatabaseRules, toStrictRulesJson } from 'pyric/sandbox/database';
import { getDatabase } from 'pyric/database';
import { getStorageSandbox } from 'pyric/storage';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import {
  DEFAULT_DATABASE_RULES_FILE,
  defaultFirestoreDatabase,
  firestoreRulesConfig,
  unservedFirestoreDatabaseWarnings,
} from 'pyric/sandbox/internal';
import { loadFirebaseJsonRules } from '../rules/api/rtdb-firebase-json.js';

interface RulesEntry {
  rules?: unknown;
}

interface FirebaseJson {
  firestore?: unknown;
  database?: unknown;
  storage?: RulesEntry | RulesEntry[];
}

const PREFIX = 'pyric/app/register';

function report(file: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${PREFIX}: could not load ${file}: ${reason}\n`);
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
  loadFirestoreRules(sandbox, projectDir, config);
  loadDatabaseRules(sandbox, projectDir, firebaseJsonPath, config);
  loadStorageRules(sandbox, projectDir, config);
}

/** The rules file a service entry names, read relative to the project, or null when it names none. */
function readDeclaredRules(projectDir: string, entry: RulesEntry | undefined): { file: string; source: string } | null {
  const file = entry?.rules;
  if (typeof file !== 'string' || file === '') return null;
  const path = resolve(projectDir, file);
  if (!existsSync(path)) throw new Error(`firebase.json names ${file}, but ${path} does not exist`);
  return { file, source: readFileSync(path, 'utf8') };
}

interface FirebaseRc {
  projects?: { default?: unknown };
  targets?: Record<string, { firestore?: Record<string, unknown> } | undefined>;
}

function readFirebaseRc(projectDir: string): FirebaseRc | null {
  const path = resolve(projectDir, '.firebaserc');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as FirebaseRc;
}

/** The databases `firebase.json` deploys Firestore rules to, with deploy targets mapped for `.firebaserc`'s default project. */
function firestoreDatabases(projectDir: string, config: FirebaseJson): ReturnType<typeof firestoreRulesConfig> {
  let rc: FirebaseRc | null | undefined;
  const readRc = (): FirebaseRc | null => (rc ??= readFirebaseRc(projectDir));
  return firestoreRulesConfig(config.firestore, {
    targetDatabases: (target) => {
      const projectId = readRc()?.projects?.default;
      return typeof projectId === 'string' ? readRc()?.targets?.[projectId]?.firestore?.[target] : undefined;
    },
  });
}

function loadFirestoreRules(sandbox: LocalSandbox, projectDir: string, config: FirebaseJson): void {
  try {
    const databases = firestoreDatabases(projectDir, config);
    for (const warning of unservedFirestoreDatabaseWarnings(databases)) process.stderr.write(`${PREFIX}: ${warning}\n`);
    // Only a file firebase.json names: register has never read an undeclared firestore.rules.
    const entry = defaultFirestoreDatabase(databases);
    const declaresRules = entry?.configured === true;
    const declared = declaresRules ? readDeclaredRules(projectDir, { rules: entry.rulesFile }) : null;
    if (declared !== null) setFirestoreRules(sandbox, declared.source);
  } catch (error) {
    report('firestore.rules', error);
  }
}

function loadDatabaseRules(
  sandbox: LocalSandbox,
  projectDir: string,
  firebaseJsonPath: string,
  config: FirebaseJson,
): void {
  const declaresNoDatabase = config.database === undefined && !existsSync(resolve(projectDir, DEFAULT_DATABASE_RULES_FILE));
  if (declaresNoDatabase) return;
  try {
    const loaded = loadFirebaseJsonRules(firebaseJsonPath);
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

function loadStorageRules(sandbox: LocalSandbox, projectDir: string, config: FirebaseJson): void {
  const entries = Array.isArray(config.storage) ? config.storage : [config.storage];
  // One local bucket: the first entry with rules, as the dev server reads it.
  const entry = entries.find((candidate) => typeof candidate?.rules === 'string');
  try {
    const declared = readDeclaredRules(projectDir, entry);
    // Storage honors rules only on the first open of the service, so it opens here.
    if (declared !== null) getStorageSandbox(sandbox, { rules: declared.source });
  } catch (error) {
    report('storage.rules', error);
  }
}
