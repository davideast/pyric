// `node client.mjs` uses the client Firebase SDKs from a server process, as a
// script or a server-rendered route does, and logs each outcome on one line:
// `<service> {"ok":true,...}` or `<service> {"ok":false,"code":...}`.
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { getStorage, ref as storageRef, uploadString } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});

async function outcome(name, run) {
  try {
    console.log(`${name} ${JSON.stringify({ ok: true, value: (await run()) ?? null })}`);
  } catch (error) {
    console.log(`${name} ${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })}`);
  }
}

await outcome("database", () => set(ref(getDatabase(app), "server/client"), "from client sdk"));
await outcome("firestore", () => setDoc(doc(getFirestore(app), "server/client"), { from: "client sdk" }));
await outcome("auth", async () =>
  (await createUserWithEmailAndPassword(getAuth(app), "node@example.com", "secret123")).user.uid);
await outcome("storage", async () =>
  (await uploadString(storageRef(getStorage(app), "server/client.txt"), "from client sdk")).metadata.fullPath);
await outcome("functions", async () => (await httpsCallable(getFunctions(app), "hello")({})).data);
process.exit(0);
