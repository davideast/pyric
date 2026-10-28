import type { FirestoreScenario } from '../scenario-types.ts';

export const scenario: FirestoreScenario = {
  observation: {
    name: 'firestore-offline-denied-write',
    rowIds: ['firestore#offline-denied-write'],
    description: 'A setDoc the rules deny, made after disableNetwork, then enableNetwork. Records the promise state while offline, the listener snapshots, and the final outcome.',
  },
  async run({ db, fs, deniedDocPath, wait, within }) {
    // The only path the rules deny is outside the oracle namespace, so the
    // write stores nothing; the server denies the listen on it as well.
    const denied = fs.doc(db, deniedDocPath);
    const events: unknown[] = [];
    const stop = fs.onSnapshot(
      denied,
      { includeMetadataChanges: true },
      (s) => events.push({ at: 'snapshot', exists: s.exists(), pending: s.metadata.hasPendingWrites, fromCache: s.metadata.fromCache }),
      (error) => events.push({ at: 'listenError', code: error.code }),
    );
    await fs.disableNetwork(db);
    let state = 'pending';
    const write = fs.setDoc(denied, { a: 1 }).then(
      () => { state = 'resolved'; },
      (error: { code?: string }) => { state = `rejected ${error.code}`; },
    );
    await wait(1000);
    const whileOffline = { state, events: events.slice() };
    await fs.enableNetwork(db);
    await within(write, 8000);
    await wait(1500);
    stop();
    return { whileOffline, finalState: state, events };
  },
};
