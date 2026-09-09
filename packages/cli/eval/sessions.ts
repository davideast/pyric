/**
 * The recorded session the assurance tasks are seeded with.
 *
 * A capture is not something to hand-write: the assurance engines read the
 * verdict each recorded request carries, and a blob typed out by hand would
 * claim verdicts nothing reached. So the session is recorded against a real
 * sandbox, and the seeder plants the result in the run's project directory as
 * `.pyric/last-session.json`.
 *
 * The recording is one team member writing and reading their own order under
 * rules that name them. Every candidate ruleset the tasks hand an agent is
 * measured against those two verdicts.
 */
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/sandbox/admin-firestore';

import { RECORDED_ORDER_RULES } from '../test/fixtures/order-rules.js';
import { buildVerifyFixture, type PyricVerifyFixture } from '../src/verify/index.js';

/**
 * Record alice writing and reading her own order under the rules in force.
 *
 * This is the value a task's `seed.session` names, rather than the recording
 * itself, so importing the corpus records nothing. The seeder calls it when it
 * plants the capture.
 */
export async function recordOrderSession(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(RECORDED_ORDER_RULES);
  await db.doc('orders/o1').set({ owner: 'alice', total: 10 });
  await db.doc('orders/o2').set({ owner: 'alice', total: 20 });
  return buildVerifyFixture({
    sandbox,
    description: 'alice writes two of her own orders',
    firestoreRules: RECORDED_ORDER_RULES,
  });
}
