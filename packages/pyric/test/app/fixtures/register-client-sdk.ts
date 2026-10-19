// Child-process fixture for register-client-sdk-refusal.test.ts: runs each
// client service through the Node register adapter under the PYRIC_SANDBOX
// the parent set, and prints one JSON line per call.
import { initializeApp } from '../../../src/app/register.js';
import { getDatabase, ref, set, get } from '../../../src/database/index.js';
import { getFirestore, doc, setDoc, getDoc } from '../../../src/firestore/index.js';
import { getAuth, signInAnonymously } from '../../../src/auth/index.js';
import { getStorage, ref as storageRef, uploadString } from '../../../src/storage/index.js';

const app = initializeApp({ apiKey: 'demo', appId: 'demo', projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' });

async function outcome(name: string, run: () => unknown): Promise<void> {
  try {
    await run();
    console.log(JSON.stringify({ name, ok: true }));
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    console.log(JSON.stringify({ name, ok: false, code: code ?? null, message: message ?? String(error) }));
  }
}

await outcome('database', () => set(ref(getDatabase(app), 'open/x'), 1));
await outcome('database.get', () => get(ref(getDatabase(app), 'open/x')));
await outcome('firestore', () => setDoc(doc(getFirestore(app), 'open/x'), { a: 1 }));
await outcome('firestore.get', () => getDoc(doc(getFirestore(app), 'open/x')));
await outcome('auth', () => signInAnonymously(getAuth(app)));
await outcome('storage', () => uploadString(storageRef(getStorage(app), 'open/x.txt'), 'x'));
