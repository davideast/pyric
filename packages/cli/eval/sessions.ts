/**
 * The recorded session the assurance tasks are seeded with.
 *
 * A capture is not something to hand-write: the assurance engines read the
 * verdict each recorded request carries, and a blob typed out by hand would
 * claim verdicts nothing reached. So the session is recorded here, once,
 * against a real sandbox, and the seeder plants the result in the run's
 * project directory as `.pyric/last-session.json`.
 *
 * The recording is one team member writing and reading their own order under
 * rules that name them. Every candidate ruleset the tasks hand an agent is
 * measured against those two verdicts.
 */
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/sandbox/admin-firestore';

import { buildVerifyFixture } from '../src/verify/index.js';

/** The rules the session was recorded under: alice, and only alice, touches an order. */
export const RECORDED_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

/** A candidate that keeps every recorded verdict: the owner still writes their order. */
export const OWNER_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} {
      allow read: if request.auth.uid == resource.data.owner;
      allow write: if request.auth.uid == request.resource.data.owner;
    }
  }
}`;

/** A candidate that breaks the session: signed in is no longer enough, and nothing is. */
export const CLOSED_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} { allow read, write: if false; }
  }
}`;

/** A candidate with the hole a campaign is meant to find: anyone writes any order. */
export const OPEN_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} { allow read, write: if true; }
  }
}`;

/** Record alice writing and reading her own order under the rules in force. */
async function recordOrderSession(): Promise<Record<string, unknown>> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(RECORDED_ORDER_RULES);
  await db.doc('orders/o1').set({ owner: 'alice', total: 10 });
  await db.doc('orders/o2').set({ owner: 'alice', total: 20 });
  const fixture = buildVerifyFixture({
    sandbox,
    description: 'alice writes two of her own orders',
    firestoreRules: RECORDED_ORDER_RULES,
  });
  return fixture as unknown as Record<string, unknown>;
}

/** The capture the assurance tasks plant. Recorded once, at module load. */
export const ORDER_SESSION: Record<string, unknown> = await recordOrderSession();

/** The paths the recording holds a verdict for. */
export const RECORDED_ORDER_PATHS = ['orders/o1', 'orders/o2'] as const;
