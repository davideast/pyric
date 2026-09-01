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
 * Initialization is exactly Firebase-shaped; package resolution selects Pyric.
 */
import { initializeApp } from 'pyric/app';
import { getDatabase, ref, set, child, get, sandbox } from 'pyric/database';

export async function run(): Promise<void> {
  const app = initializeApp({ projectId: 'entry-path-project' });
  const db = getDatabase(app);
  sandbox.setRules(db, sandbox.DEFAULT_OPEN_RULES);

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
