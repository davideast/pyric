/**
 * Denial coverage via the unified `Sandbox.onEvent` channel — verify
 * rule-denied operations surface as `kind: 'request' && result: 'deny'`
 * events, regardless of whether downstream user code catches the throw,
 * and that denials from sibling contexts route through the single
 * sandbox listener (shared environment).
 *
 * Pre-#307 these tests asserted `sandbox.onDenial(DenialEvent)`. The
 * onDenial channel was removed in the unified-channel commit — denials
 * are now a `kind === 'request' && result === 'deny'` filter over the
 * onEvent stream.
 */
import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  type RequestEvent,
  type Sandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import { getFirestore } from '../../src/firestore/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if request.auth != null
        && request.auth.uid == resource.data.ownerId;
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.ownerId;
    }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth(null));
  db.setRules(RULES);
  db.seed({
    documents: {
      'tickets/T-1': { ownerId: 'alice', title: 'first' },
    },
  });
  return { sandbox, db };
}

/** Local helper — subscribe to request-kind denials only. */
function onDenial(
  sandbox: Sandbox,
  cb: (e: RequestEvent) => void,
): () => void {
  return sandbox.onEvent((e: SandboxEvent) => {
    if (e.kind === 'request' && e.result === 'deny') cb(e);
  });
}

describe('Sandbox.onEvent (denial filter)', () => {
  it('fires on a denied read with structured request/auth/resourceBefore', async () => {
    const { sandbox } = setup();
    const events: RequestEvent[] = [];
    const unsubscribe = onDenial(sandbox, (e) => events.push(e));

    const asBob = sandbox.withAuth({ uid: 'bob' });
    try {
      await getFirestore(asBob).doc('tickets/T-1').get();
    } catch {
      /* swallow — listener is the assertion path */
    }
    unsubscribe();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.result).toBe('deny');
    expect(event.auth).toEqual({ uid: 'bob' });
    expect(event.method).toBe('get');
    expect(event.path).toBe('tickets/T-1');
    expect(event.resourceBefore?.exists).toBe(true);
    expect(event.resourceBefore?.data).toEqual({ ownerId: 'alice', title: 'first' });
  });

  it('fires on a denied create with request.resourceData populated', async () => {
    const { sandbox } = setup();
    const events: RequestEvent[] = [];
    onDenial(sandbox, (e) => events.push(e));

    const asBob = sandbox.withAuth({ uid: 'bob' });
    try {
      // bob trying to create a ticket owned by alice
      await getFirestore(asBob).doc('tickets/T-2').set({ ownerId: 'alice', title: 'nope' });
    } catch {
      /* swallow */
    }

    expect(events).toHaveLength(1);
    const event = events[0]!;
    // `RequestEvent.method` preserves the caller's verb (here `set`).
    // The rule engine maps `set` → `create` when the doc doesn't exist;
    // that mapping lives on `matchedRule.operations`.
    expect(event.method).toBe('set');
    expect(event.matchedRule?.operations).toContain('create');
    expect(event.request?.resourceData).toEqual({ ownerId: 'alice', title: 'nope' });
    // resourceBefore for set on a non-existent doc: exists:false
    expect(event.resourceBefore?.exists).toBe(false);
  });

  it('routes denials from sibling contexts through the sandbox listener', async () => {
    const { sandbox } = setup();
    const events: RequestEvent[] = [];
    onDenial(sandbox, (e) => events.push(e));

    const asBob = sandbox.withAuth({ uid: 'bob' });
    const asCarol = sandbox.withAuth({ uid: 'carol' });

    try { await getFirestore(asBob).doc('tickets/T-1').get(); } catch { /**/ }
    try { await getFirestore(asCarol).doc('tickets/T-1').get(); } catch { /**/ }

    expect(events).toHaveLength(2);
    expect(events[0]!.auth).toEqual({ uid: 'bob' });
    expect(events[1]!.auth).toEqual({ uid: 'carol' });
  });

  it('unsubscribe stops further callbacks', async () => {
    const { sandbox } = setup();
    const events: RequestEvent[] = [];
    const unsubscribe = onDenial(sandbox, (e) => events.push(e));

    const asBob = sandbox.withAuth({ uid: 'bob' });
    try { await getFirestore(asBob).doc('tickets/T-1').get(); } catch { /**/ }

    expect(events).toHaveLength(1);
    unsubscribe();

    try { await getFirestore(asBob).doc('tickets/T-1').get(); } catch { /**/ }
    expect(events).toHaveLength(1);
  });

  it('listener throws are swallowed and do not break other subscribers', async () => {
    const { sandbox } = setup();
    const events: RequestEvent[] = [];
    onDenial(sandbox, () => { throw new Error('boom'); });
    onDenial(sandbox, (e) => events.push(e));

    const asBob = sandbox.withAuth({ uid: 'bob' });
    try { await getFirestore(asBob).doc('tickets/T-1').get(); } catch { /**/ }

    expect(events).toHaveLength(1);
  });
});
