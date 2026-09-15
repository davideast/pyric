import { createThresholdConfigClient } from '../../packages/cli/src/serve/runtime/threshold-config-client.ts';
import { thresholdLimit } from '../../packages/cli/src/serve/runtime/rate-threshold-config.ts';
import type { initializeSandbox } from 'pyric/sandbox';
import * as firestore from 'pyric/firestore';
import * as database from 'pyric/database';

/** Real SDK requests on isolated demo paths; every index query can be repaired independently. */
export function createWarningScenarios(sandbox: ReturnType<typeof initializeSandbox>) {
  const db = firestore.getFirestore(sandbox);
  const rtdb = database.getDatabase(sandbox);
  return {
    firestoreDenial: () => firestore.setDoc(firestore.doc(db, 'scenario-denials/negative-budget'), { budget: -1 }),
    rtdbDenial: () => database.set(database.ref(rtdb, 'scenarioDenials/negative-budget'), { budget: -1 }),
    async firestoreIndex() {
      const path = `conversations/design/index-${crypto.randomUUID()}`;
      sandbox.admin.setDocument(`${path}/one`, { author: 'alice', budget: 5 });
      return firestore.getDocs(firestore.query(firestore.collection(db, path), firestore.where('author', '==', 'alice'), firestore.orderBy('budget', 'desc')));
    },
    rtdbIndex() {
      const path = `conversations/design/index-${crypto.randomUUID()}`;
      // The parent grants reads, while this fresh query path has no .indexOn.
      return database.get(database.query(database.ref(rtdb, path), database.orderByChild('budget'), database.equalTo(5)));
    },
  };
}

/** Keep the workload bounded while honoring the user's configured warning duration. */
export async function warningBurstPlan(service: 'firestore' | 'rtdb') {
  const settings = await createThresholdConfigClient(fetch).read();
  const config = settings?.config ?? {};
  const limit = thresholdLimit(config, service, service === 'firestore' ? 'documentWrites' : 'writes');
  if (limit === null) throw new Error('Enable the write threshold in Traffic → Rates → Thresholds to test a warning.');
  if (limit > 100) throw new Error('Set the write threshold to 100/s or less for this demo test.');
  const rate = Math.max(10, Math.ceil(limit * 2));
  return { count: rate * ((config.sustainedSeconds ?? 5) + 3), delay: 1000 / rate };
}
