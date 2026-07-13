/**
 * FROZEN dispatch-table characterization test for the SharedWorker host.
 *
 * This is the safety net for the host.ts family decomposition (worker-host
 * split): it pins the EXACT set of op method strings the host routes to a
 * handler, driven through the stable `handleMessage` seam. The routable set
 * must be byte-for-byte identical before and after the split — if a family
 * extraction drops a method from a predicate/case, that method falls through
 * to the dispatcher's "Unknown method" default and this test fails.
 *
 * HOW ROUTING IS DETECTED (payload-independent)
 * ---------------------------------------------
 * We send each method with a MINIMAL (mostly empty) payload and observe only
 * whether it was ROUTED, never whether it succeeded:
 *   - A handler that REPLIES with anything other than an "Unknown … method:"
 *     error → routed (it reached a real handler, which then may have failed on
 *     the empty payload — that's fine, we only care about routing).
 *   - A handler that THROWS (uncaught on the empty payload) → routed (it
 *     reached a real handler before throwing; the dispatcher's unknown-method
 *     default never throws, it replies).
 *   - A reply whose error message matches /Unknown …method:/ → NOT routed
 *     (fell through to a family/dispatcher default).
 *
 * The auth/ai/messaging families are already extracted into sibling host-*.ts
 * modules; they are included here so the frozen surface covers the whole host
 * dispatch, not only the families this split moves.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if true; }
    }
  }
`;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `dispatch-table-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  const db = getFirestore(sandbox);
  return { db, sandbox, subs: new Map() };
}

/** True when `method` reached a real handler (was not answered as unknown). */
async function routes(ctx: HostCtx, method: string): Promise<boolean> {
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: (m) => void messages.push(m) };
  const id = `probe-${method}`;
  try {
    await handleMessage(ctx, port, { t: 'op', id, method } as never);
  } catch {
    // A handler threw on the empty payload — it was routed.
    return true;
  }
  const res = messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (res && res.ok === false && /Unknown [\w ]*method:/.test(res.error?.message ?? '')) {
    return false;
  }
  return true;
}

/**
 * The FROZEN routable op-method surface, grouped by family. Editing this list
 * is a deliberate protocol change — it must be reviewed as one. The host must
 * route EXACTLY these method strings and no others in these families.
 */
const ROUTABLE_METHODS = {
  firestoreReads: ['getDoc', 'getDocs', 'count', 'aggregate', 'listRootCollections', 'listSubcollections'],
  firestoreWrites: ['setDoc', 'updateDoc', 'deleteDoc', 'addDoc', 'batchCommit', 'txnCommit'],
  rules: ['setRules', 'setFirestoreRules', 'setDatabaseRules', 'getActiveRules', 'getRulesStatus'],
  adminFirestore: [
    'admin.getDocument',
    'admin.listDocuments',
    'admin.setDocument',
    'admin.deleteDocument',
    'admin.readState',
  ],
  rtdb: ['rtdb.get', 'rtdb.set', 'rtdb.update', 'rtdb.remove', 'rtdb.push', 'rtdb.adminSnapshot'],
  connection: ['getVersion', 'exportState', 'importState', 'saveBranch', 'listBranches', 'switchBranch', 'deleteBranch'],
  studio: ['getSnapshot'],
  storage: [
    'storage.listAll',
    'storage.getMetadata',
    'storage.getBlob',
    'storage.putBytes',
    'storage.getBytes',
    'storage.deleteObject',
  ],
  auth: [
    'auth.createUser',
    'auth.signInEmail',
    'auth.signInAnonymously',
    'auth.signOut',
    'auth.restorePortSession',
    'auth.getIdToken',
    'auth.getIdTokenResult',
    'auth.setPersistence',
    'auth.getCurrentUser',
    'auth.updateProfile',
    'auth.acceptIdentity',
    'auth.listUsers',
    'auth.adminCreateUser',
    'auth.adminUpdateUser',
    'auth.adminDeleteUser',
    'auth.adminClearUsers',
    'auth.getProviderConfig',
    'auth.setProviderConfig',
  ],
  ai: ['ai.generateContent', 'ai.countTokens'],
  messaging: [
    'messaging.getToken',
    'messaging.deleteToken',
    'messaging.send',
    'messaging.subscribeToTopic',
    'messaging.unsubscribeFromTopic',
    'messaging.deliver',
    'messaging.setVisibility',
  ],
} as const;

const ALL_METHODS = Object.values(ROUTABLE_METHODS).flat();

describe('host dispatch table (frozen)', () => {
  let ctx: HostCtx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it('routes exactly 69 op methods across all families', () => {
    expect(ALL_METHODS.length).toBe(69);
    // No duplicates in the frozen list.
    expect(new Set(ALL_METHODS).size).toBe(69);
  });

  for (const [family, methods] of Object.entries(ROUTABLE_METHODS)) {
    describe(family, () => {
      for (const method of methods) {
        it(`routes '${method}'`, async () => {
          expect(await routes(ctx, method)).toBe(true);
        });
      }
    });
  }

  it('does NOT route unknown methods', async () => {
    for (const bogus of ['bogus', 'firestore.nope', 'rtdb.bogus', 'storage.nope', 'admin.nope', 'auth.nope', 'ai.nope']) {
      expect(await routes(ctx, bogus)).toBe(false);
    }
  });
});
