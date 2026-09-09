/**
 * Seeding. Applies an `EvalSeed` to a fresh sandbox through the same public
 * sandbox surfaces the product exposes, then persists the result with the v3
 * bundle codec the headless server reads on start. The agent under test
 * therefore begins every task with state it did not create, and no task spends
 * tool calls on setup.
 *
 * Ordering matters. Storage rules are honoured only on the first call that
 * opens the storage service, and the database default policy is stateful, so
 * rules are applied before any data write.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { setRules as setDatabaseRules, stripJsonComments } from 'pyric/sandbox/database';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
import { getAdminDatabase, ref as databaseRef, set as databaseSet } from 'pyric/database';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { saveSandboxSnapshot } from '../src/bridge/server/headless.js';
import { saveStorageSidecar } from './storage-sidecar.js';
import type { EvalSeed } from './types.js';

/** Filenames the seed writes into the run directory, one per rules service. */
export const FIRESTORE_RULES_FILE = 'firestore.rules';
export const DATABASE_RULES_FILE = 'database.rules.json';
export const STORAGE_RULES_FILE = 'storage.rules';

/** Address a seeded user needs when the record states none. */
function seedEmail(uid: string, declared: string | undefined): string {
  if (declared !== undefined) return declared;
  return `${uid}@pyric.invalid`;
}

/**
 * Seeded identities are never signed in as part of a task, so the password is a
 * placeholder rather than a credential. It is derived from the uid so a seeded
 * sandbox is byte-identical across runs.
 */
function seedPassword(uid: string): string {
  return `seed-${uid}`;
}

function applyRules(sandbox: LocalSandbox, seed: EvalSeed): void {
  // Storage first: the source is only read by the call that opens the service.
  const storageRules = seed.storageRules;
  if (storageRules !== undefined) {
    getAdminStorageSandbox(sandbox, { rules: storageRules });
  }
  const databaseRules = seed.databaseRules;
  if (databaseRules !== undefined) {
    const parsed = JSON.parse(stripJsonComments(databaseRules)) as { rules: Record<string, unknown> };
    setDatabaseRules(sandbox, parsed);
  }
  const firestoreRules = seed.firestoreRules;
  if (firestoreRules !== undefined) {
    setFirestoreRules(sandbox, firestoreRules);
  }
}

async function applyData(sandbox: LocalSandbox, seed: EvalSeed): Promise<void> {
  const users = seed.users ?? [];
  if (users.length > 0) {
    // `seedUsers` is the only entry point that carries a tenant onto the stored
    // record, so every seeded identity goes through it.
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(
      auth,
      users.map((user) => {
        const record: {
          uid: string;
          email: string;
          password: string;
          customClaims?: Record<string, unknown>;
          tenantId?: string;
        } = {
          uid: user.uid,
          email: seedEmail(user.uid, user.email),
          password: seedPassword(user.uid),
        };
        if (user.claims !== undefined) record.customClaims = user.claims;
        if (user.tenant !== undefined) record.tenantId = user.tenant;
        return record;
      }),
    );
  }

  const documents = seed.firestore ?? {};
  const db = getAdminFirestore(sandbox);
  for (const [path, data] of Object.entries(documents)) {
    await setDoc(doc(db, path), data);
  }

  const tree = seed.database;
  if (tree !== undefined) {
    const rtdb = getAdminDatabase(sandbox);
    for (const [key, value] of Object.entries(tree)) {
      await databaseSet(databaseRef(rtdb, `/${key}`), value);
    }
  }

  const objects = seed.storage ?? [];
  const storage = getAdminStorageSandbox(sandbox);
  for (const object of objects) {
    const bytes = Uint8Array.from(Buffer.from(object.contentBase64, 'base64'));
    const metadata: { contentType?: string } = {};
    if (object.contentType !== undefined) metadata.contentType = object.contentType;
    await uploadBytes(storageRef(storage, object.path), bytes, metadata);
  }
}

/** Write each declared rules source into the run directory as its own file. */
export function writeRulesFiles(dir: string, seed: EvalSeed): void {
  mkdirSync(dir, { recursive: true });
  const firestoreRules = seed.firestoreRules;
  if (firestoreRules !== undefined) {
    writeFileSync(join(dir, FIRESTORE_RULES_FILE), firestoreRules, 'utf8');
  }
  const databaseRules = seed.databaseRules;
  if (databaseRules !== undefined) {
    writeFileSync(join(dir, DATABASE_RULES_FILE), databaseRules, 'utf8');
  }
  const storageRules = seed.storageRules;
  if (storageRules !== undefined) {
    writeFileSync(join(dir, STORAGE_RULES_FILE), storageRules, 'utf8');
  }
}

/**
 * Apply a seed to a fresh sandbox and persist it as `<dir>/.pyric/state/headless.json`,
 * alongside the rules files. Returns the sandbox so a caller that wants to
 * inspect the pre-run state does not have to read the file back.
 */
export async function applySeed(dir: string, seed: EvalSeed): Promise<LocalSandbox> {
  const sandbox = initializeSandbox();
  applyRules(sandbox, seed);
  await applyData(sandbox, seed);
  writeRulesFiles(dir, seed);
  saveSandboxSnapshot(sandbox, dir);
  await saveStorageSidecar(getAdminStorageSandbox(sandbox), dir);
  return sandbox;
}
