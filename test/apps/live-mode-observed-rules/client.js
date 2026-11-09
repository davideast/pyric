import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from "firebase/auth";
import { connectDatabaseEmulator, get, getDatabase, goOffline, onValue, ref, set } from "firebase/database";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, terminate } from "firebase/firestore";

const PROJECT = "demo-observed-rules";
const config = {
  projectId: PROJECT,
  apiKey: "demo-observed-rules-key",
  appId: "1:1:web:observed-rules",
  authDomain: `${PROJECT}.firebaseapp.com`,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
};

const backend = new URLSearchParams(location.search).get("backend");

const connected = (db) =>
  new Promise((resolve) => {
    const stop = onValue(ref(db, ".info/connected"), (snapshot) => {
      if (snapshot.val() !== true) return;
      stop();
      resolve();
    });
  });

async function runSequence() {
  const app = initializeApp(config, "observed-rules-client");
  const auth = getAuth(app);
  const url = backend ? new URL(backend) : null;
  if (url) connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  const cred = await signInWithCustomToken(auth, "client-1");
  const db = getDatabase(app);
  const fs = getFirestore(app);
  if (url) {
    connectDatabaseEmulator(db, url.hostname, Number(url.port));
    connectFirestoreEmulator(fs, url.hostname, Number(url.port));
  }
  await connected(db);

  // Firestore cross-doc get() before and after observing the parent group doc:
  const initialNote = (await getDoc(doc(fs, "groups/g-1/notes/note-1"))).data();
  const groupDoc = (await getDoc(doc(fs, "groups/g-1"))).data();
  const coveredNote = (await getDoc(doc(fs, "groups/g-1/notes/note-2"))).data();

  // 1. Deep child writes: materialize `/groups/g-1/config = { plan: "pro" }` in
  //    session memory while `/groups/g-1/config/archived` remains unobserved.
  await set(ref(db, "groups/g-1/members/user-1"), true);
  await set(ref(db, "groups/g-1/config/plan"), "pro");

  // 2. Item read whose rule checks `members/user-1` AND `!config/archived.exists()`:
  //    must abstain fail-closed with `missingPaths: ['/groups/g-1/config/archived']`.
  const initialItem = (await get(ref(db, "groups/g-1/items/item-1"))).val();

  // 3. Full config subtree read: confirms `archived` is absent under `g-1/config`.
  const groupConfig = (await get(ref(db, "groups/g-1/config"))).val();

  // 4. Item write under `g-1`: now evaluates locally to decided `allow`.
  await set(ref(db, "groups/g-1/items/item-1"), { title: "Approved" });

  // 5. Archived group config read (`archived: true`), followed by item read
  //    that production allows -> local rules evaluate to decided `deny` with `drift: true`.
  await set(ref(db, "groups/g-archived/members/user-1"), true);
  const archivedConfig = (await get(ref(db, "groups/g-archived/config"))).val();
  const archivedItem = (await get(ref(db, "groups/g-archived/items/item-2"))).val();

  goOffline(db);
  await terminate(fs);
  await signOut(auth);
  await deleteApp(app);

  return {
    uid: cred.user.uid,
    initialNote,
    groupDoc,
    coveredNote,
    initialItem,
    groupConfig,
    archivedConfig,
    archivedItem,
  };
}

window.runApp = () =>
  runSequence().catch((error) => `failed: ${error.code ?? ""} ${error.message}`);
document.querySelector("#status").textContent = "Ready";
