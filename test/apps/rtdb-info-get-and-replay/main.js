import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get, onValue, runTransaction, setWithPriority } from "firebase/database";

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
