// The API server from #949: firebase-admin under `node --import
// @pyric/cli/register` with PYRIC_SANDBOX=remote:<url>. It writes a tick on an
// interval, listens to the value, and prints one JSON line per event.
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const db = getDatabase(initializeApp({ projectId: 'demo-app', databaseURL: 'https://demo-app-default-rtdb.firebaseio.com' }));
const print = event => process.stdout.write(`${JSON.stringify(event)}\n`);

db.ref('ticks').on(
  'value',
  snapshot => print({ kind: 'value', value: snapshot.val() }),
  error => print({ kind: 'listener-error', message: `${error.code ?? ''} ${error.message}` }),
);

let tick = 0;
setInterval(async () => {
  tick += 1;
  const n = tick;
  try {
    await db.ref('ticks').set(n);
    print({ kind: 'tick', n, ok: true });
  } catch (error) {
    print({ kind: 'tick', n, ok: false, message: `${error.code ?? ''} ${error.message}` });
  }
}, 250);
