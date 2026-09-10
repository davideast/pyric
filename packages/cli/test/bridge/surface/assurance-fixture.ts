/**
 * The capture and the campaign the assurance suites drive.
 *
 * One campaign, built to reach a real counterexample rather than to exercise
 * a code path: the target's rules let anyone write an order, an observation
 * records the owner writing her own, an invariant says an order's owner is
 * never rewritten to another account, and a payload mutation does exactly
 * that. The rules allow it, which is the counterexample the run loop is
 * supposed to find, the minimizer is supposed to shrink, and the owner rules
 * are supposed to close.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/sandbox/admin-firestore';

import { buildVerifyFixture, type PyricVerifyFixture } from '../../../src/verify/index.js';
import { OPEN_ORDER_RULES } from '../../fixtures/order-rules.js';

/** Rules under which only alice touches a note. */
export const ALICE_NOTE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

/** Rules under which nobody touches a note. */
export const NO_NOTE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if false; }
  }
}`;

/** A capture of alice writing two notes, both allowed by the rules in force. */
export async function recordNoteSession(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(ALICE_NOTE_RULES);
  await db.doc('notes/welcome').set({ title: 'welcome' });
  await db.doc('notes/first').set({ title: 'first' });
  return buildVerifyFixture({
    sandbox,
    description: 'alice creates two notes',
    firestoreRules: ALICE_NOTE_RULES,
  });
}

/** Write one capture into a project directory and return the path it was written to. */
export function writeCapture(
  projectDir: string,
  relative: string,
  fixture: PyricVerifyFixture,
): string {
  const path = join(projectDir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture), 'utf8');
  return path;
}

/** The campaign target: permissive order rules over two orders with different owners. */
export const OPEN_ORDER_TARGET = {
  schema: 'pyric.assurance.target.v1',
  network: 'forbid',
  rules: { firestore: OPEN_ORDER_RULES },
  state: {
    firestore: {
      'orders/o1': { owner: 'alice', total: 10 },
      'orders/o2': { owner: 'bob', total: 20 },
    },
    auth: {
      users: [{ uid: 'alice', email: 'alice@example.com', password: 'seed-alice' }],
    },
  },
};

/**
 * The identity the campaign can actually acquire. A fixture user is an
 * account the target really holds, so a finding under it is demonstrated
 * rather than a candidate signal about an identity nobody can obtain.
 */
export const ALICE_ACTOR = {
  id: 'alice',
  acquisition: { kind: 'fixture-user', uid: 'alice' },
};

/** What alice was seen doing, which every probe starts from. */
export const OWNER_WRITE_OBSERVATION = {
  id: 'alice-writes-own-order',
  actorId: 'alice',
  operation: {
    service: 'firestore',
    method: 'set',
    path: 'orders/o1',
    data: { owner: 'alice', total: 10 },
  },
  result: 'ALLOW',
  source: 'captured',
};

/** The boundary the campaign is judging against. */
export const OWNER_ONLY_INVARIANT = {
  id: 'orders-are-owner-only',
  statement: "An order's owner is never rewritten to another account.",
  service: 'firestore',
  expected: 'DENY',
  source: 'declared',
  confidence: 'authoritative',
};

/** One payload change alice never made, in four fields the minimizer can shrink. */
export const PAYLOAD_MUTATION = {
  dimension: 'payload',
  description: 'rewrite the order with fields the owner never sent',
  operation: {
    service: 'firestore',
    method: 'set',
    path: 'orders/o1',
    data: { owner: 'bob', total: 999, refunded: true, adminNote: 'comped' },
  },
};

/** The probe id `propose` mints for the payload mutation. */
export const PAYLOAD_PROBE_ID = 'alice-writes-own-order-payload-1';
