/**
 * Apply a typed seed to a sandbox, through the public sandbox surfaces the
 * product exposes rather than a raw snapshot restore.
 *
 * This is the one implementation of "what a seed does to a sandbox." The eval
 * harness seeds a fresh sandbox with it before a run starts, and the
 * `sandbox.seed` operation calls the same two functions against the live
 * sandbox, so a task's seed and an agent's own seed call are one shape and one
 * code path. The shape matches `EvalSeed` in `packages/cli/eval/types.ts`
 * structurally; nothing here imports that module, because `eval/` sits
 * outside this package's build root.
 *
 * Ordering matters. Storage rules are honored only on the first call that
 * opens the storage service, and the database default policy is stateful, so
 * rules are applied before any data write.
 */
import { stripJsonComments } from 'pyric/sandbox/database';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import type { LocalSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
import { getAdminDatabase, ref as databaseRef, set as databaseSet } from 'pyric/database';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

/** State to load into a sandbox, matching `EvalSeed` field for field. */
export interface SandboxSeed {
  firestoreRules?: string;
  databaseRules?: string;
  storageRules?: string;
  users?: Array<{ uid: string; email?: string; claims?: Record<string, unknown>; tenant?: string }>;
  firestore?: Record<string, Record<string, unknown>>;
  database?: Record<string, unknown>;
  storage?: Array<{ path: string; contentBase64: string; contentType?: string }>;
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

/** Install the rules a seed carries. Storage first: its source is only read by the call that opens the service. */
export function applyRules(sandbox: LocalSandbox, seed: SandboxSeed): void {
  const storageRules = seed.storageRules;
  if (storageRules !== undefined) {
    // A seed may carry rules that do not parse on purpose, for lint tasks. The
    // seeding sandbox opens storage without them rather than throwing.
    try {
      getAdminStorageSandbox(sandbox, { rules: storageRules });
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
