/**
 * Node-only candidate rules resolution for `pyric verify` across `(default)`
 * and named Cloud Firestore databases (`--rules firestore=<path>`,
 * `--rules firestore:<database>=<path>`, and `firebase.json` + `.firebaserc`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_FIRESTORE_DATABASE,
  isValidFirestoreDatabaseId,
} from 'pyric/firestore/internal';
import { bundleRulesSource } from 'pyric/rules/internal/usage';
import {
  defaultFirestoreDatabase,
  type FirestoreDatabaseConfig,
  type FirestoreRulesConfig,
} from 'pyric/sandbox/internal';

import { resolveContainedRulesFile } from '../cli/contained-rules-file.js';
import { readFirebaseRcSync, type FirebaseJson } from '../cli/firebase-json.js';
import { firestoreDatabases, MODULAR_SOURCE } from '../serve/rules.js';
import type { PyricVerifyFixture } from './fixture.js';
import {
  recordedFirestoreDatabases,
  recordsDefaultFirestoreDatabase,
} from './firestore-databases.js';
import type { VerifyRulesInput } from './index.js';

/** The `--rules` values for Firestore: `firestore=<path>` and each `firestore:<database>=<path>`. */
export interface FirestoreRulesOverrides {
  default?: string;
  databases: Array<{ database: string; path: string }>;
}

export interface FirestoreCandidateRulesInput {
  cwd: string;
  fixtures: readonly PyricVerifyFixture[];
  overrides: FirestoreRulesOverrides;
  readFirebaseJson: () => Promise<FirebaseJson | null>;
  project?: string;
}

export interface FirestoreCandidateRules {
  rules: Pick<VerifyRulesInput, 'firestore' | 'firestoreDatabases'>;
  paths: Record<string, string>;
}

type DatabaseKey = string | undefined;

const DATABASE_RULES_PREFIX = /^firestore:/;

function isPlainRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Whether a `--rules` key names a specific Firestore database (`firestore:<database>`). */
export function isFirestoreDatabaseRulesKey(key: string): boolean {
  return DATABASE_RULES_PREFIX.test(key);
}

/** Extract `<database>` from a `firestore:<database>` `--rules` key. */
export function firestoreDatabaseOfRulesKey(key: string): string {
  return key.replace(DATABASE_RULES_PREFIX, '');
}

function describeDatabase(key: DatabaseKey): string {
  if (key === undefined) return 'the (default) database';
  return `database "${key}"`;
}

function pathKey(key: DatabaseKey): string {
  if (key === undefined) return 'firestore';
  return `firestore:${key}`;
}

function normalizeOverrideKey(raw: string): DatabaseKey {
  if (raw === DEFAULT_FIRESTORE_DATABASE) return undefined;
  if (!isValidFirestoreDatabaseId(raw)) {
    throw new Error(`--rules firestore:${raw}: "${raw}" is not a valid Firestore database id.`);
  }
  return raw;
}

function recordedList(needed: readonly DatabaseKey[]): string {
  if (needed.length === 0) return 'none';
  return needed.map((key) => key ?? DEFAULT_FIRESTORE_DATABASE).join(', ');
}

function unrecordedOverrideMessage(
  raw: string,
  key: DatabaseKey,
  needed: readonly DatabaseKey[],
  config: FirebaseJson | null,
): string {
  const lines = [
    `--rules firestore:${raw}: the session never used ${describeDatabase(key)}. Databases the session used: ${recordedList(needed)}.`,
  ];
  const entries = Array.isArray(config?.firestore) ? config.firestore : [];
  const isTarget = entries.some(
    (entry) => isPlainRecord(entry) && (entry as { target?: unknown }).target === raw,
  );
  if (isTarget) {
    lines.push(`"${raw}" is a deploy target in firebase.json; name the database it deploys to.`);
  }
  return lines.join(' ');
}

function missingCandidateMessage(
  key: DatabaseKey,
  resolvedConfig: FirestoreRulesConfig | undefined,
): string {
  if (key === undefined) {
    return 'missing candidate firestore rules. Pass --rules firestore=<path> or configure firebase.json.';
  }
  const lines = [`missing candidate firestore rules for database "${key}", which the session used.`];
  for (const pending of resolvedConfig?.unresolved ?? []) {
    lines.push(
      `firebase.json deploy target "${pending.target}" (${pending.label}) did not resolve; pass --project or map it in .firebaserc.`,
    );
  }
  lines.push(`Pass --rules firestore:${key}=<path>, or deploy rules to it in firebase.json.`);
  return lines.join(' ');
}

function loadContainedFirestoreRules(
  cwd: string,
  rel: string,
  key: DatabaseKey,
): { resolvedPath: string; realFile: string; source: string } {
  const checked = resolveContainedRulesFile({
    projectRoot: cwd,
    lexicalProjectRoot: cwd,
    cwd,
    fileArg: rel,
  });
  if (!checked.ok) {
    const suffix = key === undefined ? 'firestore' : `firestore ${describeDatabase(key)}`;
    if (checked.kind === 'not-found') {
      throw new Error(`rules file not found for ${suffix}: ${resolve(cwd, rel)}`);
    }
    throw new Error(`invalid ${suffix} rules path: ${checked.message}`);
  }
  const resolvedPath = checked.resolvedPath;
  const raw = readFileSync(checked.realFile, 'utf8');
  let source = raw;
  if (MODULAR_SOURCE.test(raw)) {
    try {
      source = bundleRulesSource(raw, {
        filePath: checked.realFile,
        rootDir: checked.realRoot,
        sourceFile: resolvedPath,
        targetService: 'cloud.firestore',
      });
    } catch (err) {
      let msg = String(err);
      if (err instanceof Error) msg = err.message;
      throw new Error(`firestore rules module resolution failed (${resolvedPath}): ${msg}`);
    }
  }
  return { resolvedPath, realFile: checked.realFile, source };
}

function configuredEntryForKey(
  resolvedConfig: FirestoreRulesConfig,
  key: DatabaseKey,
): FirestoreDatabaseConfig | undefined {
  if (key === undefined) {
    const entry = defaultFirestoreDatabase(resolvedConfig);
    if (entry?.configured === true) return entry;
    return undefined;
  }
  const entry = resolvedConfig.databases.find((item) => item.database === key);
  if (entry?.configured === true) return entry;
  return undefined;
}

/** Resolve candidate Firestore rules across `(default)` and every named database recorded in `fixtures`. */
export async function resolveFirestoreCandidateRules(
  input: FirestoreCandidateRulesInput,
): Promise<FirestoreCandidateRules> {
  const named = [...new Set(input.fixtures.flatMap(recordedFirestoreDatabases))].sort();
  const needed: DatabaseKey[] = [];
  if (input.fixtures.some(recordsDefaultFirestoreDatabase)) {
    needed.push(undefined);
  }
  needed.push(...named);

  let cachedConfig: FirebaseJson | null | undefined;
  const readConfig = async (): Promise<FirebaseJson | null> => {
    if (cachedConfig === undefined) {
      cachedConfig = await input.readFirebaseJson();
    }
    return cachedConfig;
  };

  const chosen = new Map<DatabaseKey, string>();
  if (input.overrides.default !== undefined) {
    if (!needed.includes(undefined) && needed.length > 0) {
      throw new Error(
        `--rules firestore=${input.overrides.default}: the session never used ${describeDatabase(undefined)}. Databases the session used: ${recordedList(needed)}.`,
      );
    }
    if (!needed.includes(undefined)) {
      needed.push(undefined);
    }
    chosen.set(undefined, input.overrides.default);
  }

  for (const override of input.overrides.databases) {
    const key = normalizeOverrideKey(override.database);
    if (!needed.includes(key)) {
      throw new Error(unrecordedOverrideMessage(override.database, key, needed, await readConfig()));
    }
    const existing = chosen.get(key);
    if (existing !== undefined) {
      const checkedExisting = loadContainedFirestoreRules(input.cwd, existing, key);
      const checkedNext = loadContainedFirestoreRules(input.cwd, override.path, key);
      if (checkedExisting.realFile !== checkedNext.realFile) {
        throw new Error(
          `--rules names two rules files for ${describeDatabase(key)}: ${existing} and ${override.path}.`,
        );
      }
    }
    chosen.set(key, override.path);
  }

  let resolvedConfig: FirestoreRulesConfig | undefined;
  const unresolved = needed.filter((key) => !chosen.has(key));
  if (unresolved.length > 0) {
    const config = await readConfig();
    const projectId = input.project ?? readFirebaseRcSync(input.cwd)?.projects?.default;
    const projectOpts: { projectId?: string } = {};
    if (projectId !== undefined) {
      projectOpts.projectId = projectId;
    }
    try {
      resolvedConfig = firestoreDatabases(input.cwd, config, projectOpts);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(msg.replace(/^pyric sandbox: /, ''));
    }
    for (const key of unresolved) {
      const entry = configuredEntryForKey(resolvedConfig, key);
      if (entry?.rulesFile !== undefined) {
        chosen.set(key, entry.rulesFile);
      }
    }
  }

  const rules: FirestoreCandidateRules['rules'] = {};
  const paths: Record<string, string> = {};
  for (const key of needed) {
    const rel = chosen.get(key);
    if (rel === undefined) {
      throw new Error(missingCandidateMessage(key, resolvedConfig));
    }
    const loaded = loadContainedFirestoreRules(input.cwd, rel, key);
    paths[pathKey(key)] = loaded.resolvedPath;
    if (key === undefined) {
      rules.firestore = loaded.source;
    } else {
      if (rules.firestoreDatabases === undefined) {
        rules.firestoreDatabases = {};
      }
      setOwnEntry(rules.firestoreDatabases, key, loaded.source);
    }
  }

  return { rules, paths };
}
