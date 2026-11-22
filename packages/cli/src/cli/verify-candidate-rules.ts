/**
 * Candidate rules resolution (`--rules` overrides and `firebase.json` lookup)
 * across Firestore, Realtime Database, and Storage for `pyric verify`.
 */
import {
  firestoreDatabaseOfRulesKey,
  isFirestoreDatabaseRulesKey,
  resolveFirestoreCandidateRules,
  type FirestoreRulesOverrides,
} from '../verify/firestore-candidate-rules.js';
import type {
  PyricVerifyFixture,
  VerifiableService,
  VerifyRulesInput,
} from '../verify/index.js';
import { readFirebaseJson, type FirebaseJson } from './firebase-json.js';
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

function parseRulesOverrides(flag: FlagValue | undefined): {
  firestore: FirestoreRulesOverrides;
  rtdb: RtdbRulesOverrides;
  storage: StorageRulesOverrides;
} {
  const out: {
    firestore: FirestoreRulesOverrides;
    rtdb: RtdbRulesOverrides;
    storage: StorageRulesOverrides;
  } = {
    firestore: { databases: [] },
    rtdb: { instances: [] },
    storage: { buckets: [] },
  };
  for (const raw of flagStrings(flag)) {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(
        '--rules must use service-qualified values like --rules rtdb=database.rules.json or --rules firestore:<database>=<path>.',
      );
    }
    const key = raw.slice(0, eq);
    const path = raw.slice(eq + 1);
    if (isFirestoreDatabaseRulesKey(key)) {
      out.firestore.databases.push({ database: firestoreDatabaseOfRulesKey(key), path });
      continue;
    }
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
    else out.firestore.default = path;
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
    const firestoreInput: {
      cwd: string;
      fixtures: PyricVerifyFixture[];
      overrides: FirestoreRulesOverrides;
      readFirebaseJson: () => Promise<FirebaseJson | null>;
      project?: string;
    } = {
      cwd,
      fixtures: input.fixtures,
      overrides: overrides.firestore,
      readFirebaseJson: readConfig,
    };
    if (input.project) {
      firestoreInput.project = input.project;
    }
    const firestore = await resolveFirestoreCandidateRules(firestoreInput);
    Object.assign(rules, firestore.rules);
    Object.assign(paths, firestore.paths);
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
