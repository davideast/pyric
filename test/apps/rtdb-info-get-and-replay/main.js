import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  get,
  getDatabase,
  limitToFirst,
  onValue,
  orderByPriority,
  query,
  ref,
  runTransaction,
  setWithPriority,
} from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const auth = getAuth(app);
const db = getDatabase(app);

window.repro = {
  signIn: async () => (await signInAnonymously(auth)).user.uid,
  // A one-shot read of the connection state: production rejects it.
  getConnected: async () => {
    try {
      return { resolved: (await get(ref(db, ".info/connected"))).val() };
    } catch (error) {
      return { error: error.message, code: error.code ?? null };
    }
  },
  // A listener on the connection state keeps working.
  listenConnected: () => new Promise((resolve, reject) => {
    const off = onValue(ref(db, ".info/connected"), (snapshot) => { off(); resolve(snapshot.val()); }, reject);
  }),
  // A prioritized scalar leaf gated by `.read: "query.orderByPriority == true"`:
  // plain `get(ref)` is denied, unfiltered `orderByPriority()` forwards the
  // ordering and keeps the scalar leaf + priority across `get()` and `onValue()`,
  // and `limitToFirst(1)` still filters the scalar leaf to `null`.
  queryPrioritizedScalar: async () => {
    const rankedRef = ref(db, "ranked");
    await setWithPriority(rankedRef, 125, 7);
    let plainError = null;
    try {
      await get(rankedRef);
    } catch (error) {
      plainError = error.message;
    }
    const unfiltered = await get(query(rankedRef, orderByPriority()));
    const listened = await new Promise((resolve, reject) => {
      let detached = false;
      let off;
      off = onValue(
        query(rankedRef, orderByPriority()),
        (snapshot) => {
          if (detached) return;
          detached = true;
          if (off) off();
          resolve(snapshot.exportVal());
        },
        reject,
      );
      if (detached && off) off();
    });
    const limited = await get(query(rankedRef, orderByPriority(), limitToFirst(1)));
    return {
      plainError,
      unfiltered: {
        exists: unfiltered.exists(),
        val: unfiltered.val(),
        priority: unfiltered.priority,
        exportVal: unfiltered.exportVal(),
        size: unfiltered.size,
      },
      listened,
      limited: {
        exists: limited.exists(),
        val: limited.val(),
      },
    };
  },
  // A node with a priority, then a transaction on it: the rules deny the
  // transaction because the node exists, and it would keep the priority.
  writePrioritized: () => setWithPriority(ref(db, "t"), 1, 5),
  transactPrioritized: async () => {
    try {
      await runTransaction(ref(db, "t"), () => 2);
      return "allowed";
    } catch (error) {
      return error.message;
    }
  },
};
