/**
 * Entry-path conformance program — `pyric/app` + `pyric/database`.
 *
 * Adapted from Firebase's official web quickstart shape:
 *   - https://firebase.google.com/docs/database/web/start
 *     (`initializeApp`, `getDatabase`)
 *   - https://firebase.google.com/docs/database/web/read-and-write
 *     (the `writeUserData` `ref` + `set` example, and the `child` + `get`
 *     "read data once" example)
 *
 * The only adjustment pyric requires: `initializeApp({ sandbox:
 * initializeSandbox() })` in place of `initializeApp(firebaseConfig)`.
 */
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, child, get } from 'pyric/database';

export async function run(): Promise<void> {
  const app = initializeApp({ sandbox: initializeSandbox() });
  const db = getDatabase(app);

  // https://firebase.google.com/docs/database/web/read-and-write —
  // `writeUserData`: the one real operation this program performs.
  const userId = 'ada-lovelace';
  await set(ref(db, 'users/' + userId), {
    username: 'Ada Lovelace',
    email: 'ada.lovelace@example.com',
  });

  // Same doc, "Read data once" — asserts the write actually landed.
  const dbRef = ref(db);
  const snapshot = await get(child(dbRef, `users/${userId}`));

  if (!snapshot.exists()) {
    throw new Error(`get(child(dbRef, 'users/${userId}')) found no data after set()`);
  }
  const val = snapshot.val() as { username?: unknown };
  if (val?.username !== 'Ada Lovelace') {
    throw new Error(`snapshot.val().username did not round-trip (got ${JSON.stringify(val)})`);
  }
}
