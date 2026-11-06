/**
 * The calls the `live-mode-traffic` app scenario makes, for recording
 * `live-mode-traffic.json` from a real test project. No test or scenario
 * runs this: it reaches Google, so a person runs it by hand, once, through
 * the recorder:
 *
 *   REPLAY_WEB_CONFIG='<the test project web config, as JSON>' \
 *   REPLAY_READER_PASSWORD=... REPLAY_WRITER_PASSWORD=... \
 *   bun test/apps/replay/record.ts --project <test-project> \
 *     --out test/apps/replay/fixtures/live-mode-traffic.json \
 *     test/apps/replay/fixtures/live-mode-traffic.run.ts
 *
 * The test project needs, and holds nothing else:
 *
 * - two email and password accounts, `reader@example.com` and `writer@example.com`;
 * - `rooms/lobby` = `{ name: 'Lobby', open: true, seats: 12 }`, and no `rooms/garden` or `rooms/patio`;
 * - the rules in `test/apps/live-mode-traffic/firestore.rules`, which deny `rooms/secret`.
 *
 * The recording is in the format the page's WebChannel streams carry; the
 * replay server answers the Node build's gRPC streams from it too. The
 * scenario reads the project and each account's uid from the file, so a new
 * recording needs no change to it. Delete `rooms/garden` and `rooms/patio`
 * before recording again.
 */
import type { Sdk } from '../sdk.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}

/** One account's calls, in the scenario's order: sign in, read, listen, be denied, write. */
async function account(sdk: Sdk, name: string, email: string, password: string, room: string): Promise<void> {
  const { app, auth, firestore } = sdk;
  const project = app.initializeApp(JSON.parse(required('REPLAY_WEB_CONFIG')) as Record<string, string>, name);
  await auth.signInWithEmailAndPassword(auth.getAuth(project), email, password);
  const db = firestore.getFirestore(project);
  await firestore.getDoc(firestore.doc(db, 'rooms/lobby'));
  await firestore.getDoc(firestore.doc(db, 'rooms/secret')).catch(() => undefined);
  const open = firestore.query(firestore.collection(db, 'rooms'), firestore.where('open', '==', true));
  let stop = () => {};
  const listed = new Promise<void>((resolve, reject) => {
    stop = firestore.onSnapshot(open, (snapshot) => {
      const fromServer = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
      if (fromServer && snapshot.docs.some((entry) => entry.id === room)) resolve();
    }, reject);
  });
  await firestore.setDoc(firestore.doc(db, `rooms/${room}`), { name: room[0]!.toUpperCase() + room.slice(1), open: true });
  await listed;
  stop();
}

export default async function run(sdk: Sdk): Promise<void> {
  await account(sdk, 'reader', 'reader@example.com', required('REPLAY_READER_PASSWORD'), 'garden');
  await account(sdk, 'writer', 'writer@example.com', required('REPLAY_WRITER_PASSWORD'), 'patio');
}
