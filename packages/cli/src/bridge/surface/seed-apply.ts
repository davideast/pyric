/**
 * Apply a typed seed to a sandbox, through the public sandbox surfaces the
 * product exposes rather than a raw snapshot restore.
 *
 * This is the one implementation of "what a seed does to a sandbox." The eval
 * harness seeds a fresh sandbox with it before a run starts, and the
 * `sandbox.seed` operation calls the same two functions against the live
 * sandbox, so a task's seed and an agent's own seed call are one shape and one
 * code path. `SandboxSeed` is that one shape: the harness's `EvalSeed` is an
 * alias of it rather than a second declaration of the same fields.
 *
 * Ordering matters. The database default policy is stateful and every write
 * is evaluated against whatever ruleset is in force, so rules are applied
 * before any data write.
 */
import { setRules as setDatabaseRules, stripJsonComments } from 'pyric/sandbox/database';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import type { LocalSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
import { getAdminDatabase, ref as databaseRef, set as databaseSet } from 'pyric/database';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

/** One seeded user, as a plain data record rather than a validated Zod shape. */
export interface SeedUserEntry {
  uid: string;
  email?: string;
  customClaims?: Record<string, unknown>;
  tenantId?: string;
  /**
   * The real password to seed, rather than the synthetic `seed-<uid>` one. A
   * fixture the surface writes never carries one, so this is set only by a
   * seed a person or the harness authored.
   */
  password?: string;
}

/** One seeded storage object. */
export interface SeedStorageEntry {
  path: string;
  contentBase64: string;
  contentType?: string;
}

/** State to load into a sandbox. The harness's `EvalSeed` is an alias of this. */
export interface SandboxSeed {
  firestoreRules?: string;
  databaseRules?: string;
  storageRules?: string;
  users?: SeedUserEntry[];
  /** Document path to document data. */
  firestore?: Record<string, Record<string, unknown>>;
  /** Realtime Database tree written at the root. */
  database?: Record<string, unknown>;
  storage?: SeedStorageEntry[];
}

/** Address a seeded user needs when the record states none. */
function seedEmail(uid: string, declared: string | undefined): string {
  if (declared !== undefined) return declared;
  return `${uid}@pyric.invalid`;
}

/**
 * Seeded identities are never signed in as part of seeding, so the password is
 * a placeholder rather than a credential. It is derived from the uid so a
 * seeded sandbox is byte-identical across runs.
 */
function seedPassword(uid: string): string {
  return `seed-${uid}`;
}

/** Install the rules a seed carries, before any data write. */
export async function applyRules(sandbox: LocalSandbox, seed: SandboxSeed): Promise<void> {
  const storageRules = seed.storageRules;
  if (storageRules !== undefined) {
    // A seed may carry rules that do not parse on purpose, for lint tasks. The
    // seeding sandbox opens storage without them rather than throwing.
    try {
      await replaceStorageRules(sandbox, storageRules);
    } catch {
      getAdminStorageSandbox(sandbox);
    }
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

/** Load the data a seed carries: users, documents, database tree, storage objects. */
export async function applyData(sandbox: LocalSandbox, seed: SandboxSeed): Promise<void> {
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
          password: user.password ?? seedPassword(user.uid),
        };
        if (user.customClaims !== undefined) record.customClaims = user.customClaims;
        if (user.tenantId !== undefined) record.tenantId = user.tenantId;
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
