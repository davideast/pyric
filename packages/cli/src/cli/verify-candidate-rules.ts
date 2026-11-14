/**
 * Candidate rules resolution (`--rules` overrides and `firebase.json` lookup)
 * across Firestore, Realtime Database, and Storage for `pyric verify`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultFirestoreDatabase } from 'pyric/sandbox/internal';
import { firestoreDatabases, MODULAR_SOURCE, resolveProjectModules } from '../serve/rules.js';
import type {
  PyricVerifyFixture,
  VerifiableService,
  VerifyRulesInput,
} from '../verify/index.js';
import { readFirebaseJson, readFirebaseRcSync, type FirebaseJson } from './firebase-json.js';
import type { FlagValue } from './parse-args.js';
import {
  isRtdbInstanceRulesKey,
  resolveRtdbCandidateRules,
  rtdbInstanceOfRulesKey,
  type RtdbRulesOverrides,
} from './verify-rtdb-rules.js';
import {
  isStorageBucketRulesKey,
  resolveStorageCandidateRules,
  storageBucketOfRulesKey,
  type StorageRulesOverrides,
} from './verify-storage-rules.js';

export interface CandidateRulesInput {
  cwd: string;
  services: VerifiableService[];
  fixtures: PyricVerifyFixture[];
  rulesFlag: FlagValue | undefined;
  project: string | undefined;
}

export function flagStrings(value: FlagValue | undefined): string[] {
  let values: Array<string | boolean> = [value as string | boolean];
  if (Array.isArray(value)) {
    values = value;
  }
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function stringFlag(value: FlagValue | undefined): string | undefined {
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value;
  return undefined;
}

export function toVerifiableService(raw: string): VerifiableService {
  if (raw === 'firestore' || raw === 'rtdb' || raw === 'storage') return raw;
  if (raw === 'database') return 'rtdb';
  throw new Error(`unsupported verify service '${raw}'. Supported services: firestore, rtdb, storage.`);
}

async function readFirebaseJsonOrNull(cwd: string): Promise<FirebaseJson | null> {
  try {
    return await readFirebaseJson(cwd);
  } catch {
    return null;
  }
}

/** The rules file `firebase.json` names for the `(default)` Firestore database, from either `firestore` form. */
function configuredFirestoreRules(
  cwd: string,
  config: FirebaseJson | null,
  project: string | undefined,
): string | undefined {
  const projectId = project ?? readFirebaseRcSync(cwd)?.projects?.default;
  const projectOpts: { projectId?: string } = {};
  if (projectId !== undefined) {
    projectOpts.projectId = projectId;
  }
  const databases = firestoreDatabases(cwd, config, projectOpts);
  const entry = defaultFirestoreDatabase(databases);
  if (entry?.configured === true) return entry.rulesFile;
  return undefined;
}

function parseRulesOverrides(flag: FlagValue | undefined): {
  firestore?: string;
  rtdb: RtdbRulesOverrides;
  storage: StorageRulesOverrides;
} {
  const out: { firestore?: string; rtdb: RtdbRulesOverrides; storage: StorageRulesOverrides } = {
    rtdb: { instances: [] },
    storage: { buckets: [] },
  };
  for (const raw of flagStrings(flag)) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(
        '--rules must use service-qualified values like --rules rtdb=database.rules.json or --rules rtdb:<instance>=<path>.',
      );
    }
    const key = raw.slice(0, eq);
    const path = raw.slice(eq + 1);
    if (isRtdbInstanceRulesKey(key)) {
      out.rtdb.instances.push({ instance: rtdbInstanceOfRulesKey(key), path });
      continue;
    }
    if (isStorageBucketRulesKey(key)) {
      out.storage.buckets.push({ bucket: storageBucketOfRulesKey(key), path });
      continue;
    }
    const service = toVerifiableService(key);
    if (service === 'rtdb') out.rtdb.default = path;
    else if (service === 'storage') out.storage.default = path;
    else out.firestore = path;
  }
  return out;
}

export async function resolveCandidateRules(
  input: CandidateRulesInput,
): Promise<{ rules: VerifyRulesInput; paths: Record<string, string> }> {
  const { cwd, services } = input;
  const overrides = parseRulesOverrides(input.rulesFlag);
  let firebaseJson: Promise<FirebaseJson | null> | undefined;
  const readConfig = (): Promise<FirebaseJson | null> => {
    firebaseJson ??= readFirebaseJsonOrNull(cwd);
    return firebaseJson;
  };

  const rules: VerifyRulesInput = {};
  const paths: Record<string, string> = {};
  if (services.includes('firestore')) {
    const rel = overrides.firestore ?? configuredFirestoreRules(cwd, await readConfig(), input.project);
    if (!rel) {
      throw new Error('missing candidate firestore rules. Pass --rules firestore=<path> or configure firebase.json.');
    }
    const path = resolve(cwd, rel);
    if (!existsSync(path)) {
      throw new Error(`rules file not found for firestore: ${path}`);
    }
    paths.firestore = path;
    const raw = readFileSync(path, 'utf8');
    if (MODULAR_SOURCE.test(raw)) {
      const resolved = resolveProjectModules(raw, path, path, 'cloud.firestore').result;
      if (!resolved.success) {
        throw new Error(`firestore rules module resolution failed (${path}): ${resolved.error.message}`);
      }
      rules.firestore = resolved.data.resolved;
    } else {
      rules.firestore = raw;
    }
  }
  if (services.includes('rtdb')) {
    const rtdbInput: {
      cwd: string;
      fixtures: PyricVerifyFixture[];
      overrides: RtdbRulesOverrides;
      readFirebaseJson: () => Promise<FirebaseJson | null>;
      project?: string;
    } = {
      cwd,
      fixtures: input.fixtures,
      overrides: overrides.rtdb,
      readFirebaseJson: readConfig,
    };
    if (input.project) {
      rtdbInput.project = input.project;
    }
    const rtdb = await resolveRtdbCandidateRules(rtdbInput);
    Object.assign(rules, rtdb.rules);
    Object.assign(paths, rtdb.paths);
  }
  if (services.includes('storage')) {
    const storageInput: {
      cwd: string;
      fixtures: PyricVerifyFixture[];
      overrides: StorageRulesOverrides;
      readFirebaseJson: () => Promise<FirebaseJson | null>;
      project?: string;
    } = {
      cwd,
      fixtures: input.fixtures,
      overrides: overrides.storage,
      readFirebaseJson: readConfig,
    };
    if (input.project) {
      storageInput.project = input.project;
    }
    const storage = await resolveStorageCandidateRules(storageInput);
    Object.assign(rules, storage.rules);
    Object.assign(paths, storage.paths);
  }
  return { rules, paths };
}
