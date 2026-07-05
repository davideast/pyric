/**
 * `sandbox.admin.*` rule-bypass reads.
 *
 * Admin is identity-agnostic — it lives on `Sandbox`, not on
 * `SandboxContext`, because rule-bypass reads aren't gated on auth.
 * What's locked here:
 *   - admin reads return data regardless of rules (no auth context
 *     attached, no rule evaluation in the path)
 *   - admin reads see writes immediately after they land
 *   - admin is available regardless of how many contexts exist on
 *     the sandbox
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from '../../src/firestore/index.js';

const STRICT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      // Reads always denied, but admin should bypass.
      allow read: if false;
      allow write: if request.auth != null;
    }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  // Setup writes go through an explicit context. Auth is `alice` here
  // because the strict rule requires auth on writes.
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(STRICT_RULES);
  db.seed({
    documents: {
      'tickets/T-1': { ownerId: 'alice', title: 'first' },
      'tickets/T-2': { ownerId: 'bob', title: 'second' },
    },
  });
  return { sandbox, db };
}

describe('sandbox.admin.getDocument', () => {
  it('reads a document despite a deny-all read rule', () => {
    const { sandbox } = setup();
    const data = sandbox.admin.getDocument('tickets/T-1');
    expect(data).toEqual({ ownerId: 'alice', title: 'first' });
  });

  it('returns null for a missing document', () => {
    const { sandbox } = setup();
    expect(sandbox.admin.getDocument('tickets/missing')).toBeNull();
  });

  it('observes writes immediately after they land', async () => {
    const { sandbox, db } = setup();
    await db.doc('tickets/T-3').set({ ownerId: 'alice', title: 'fresh' });
    expect(sandbox.admin.getDocument('tickets/T-3')).toEqual({
      ownerId: 'alice',
      title: 'fresh',
    });
  });
});

describe('sandbox.admin.listDocuments', () => {
  it('lists every document under the collection prefix', () => {
    const { sandbox } = setup();
    const list = sandbox.admin.listDocuments('tickets');
    const paths = list.map((r) => r.path).sort();
    expect(paths).toEqual(['tickets/T-1', 'tickets/T-2']);
  });

  it('returns an empty array for an unknown prefix', () => {
    const { sandbox } = setup();
    expect(sandbox.admin.listDocuments('nonexistent')).toEqual([]);
  });
});

describe('sandbox.admin is identity-agnostic', () => {
  it('admin reads work regardless of how many contexts exist on the sandbox', () => {
    const { sandbox } = setup();
    // Create a few contexts; admin should remain accessible directly.
    sandbox.withAuth(null);
    sandbox.withAuth({ uid: 'bob' });
    sandbox.withAuth({ uid: 'admin', token: { admin: true } });
    expect(sandbox.admin.getDocument('tickets/T-1')).toEqual({
      ownerId: 'alice',
      title: 'first',
    });
  });
});
