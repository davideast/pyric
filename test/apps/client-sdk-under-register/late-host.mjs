// `node late-host.mjs` starts before its host, as a server process started
// ahead of `pyric sandbox` or the dev server does. Its first calls fail,
// because no host answers. Once the file `late-host-go` appears, the
// scenario has started the host, and the same app's calls must reach it,
// as firebase-admin's do and as a production SDK's do once its backend is
// reachable. Logs `<name> {"ok":...}` per call, deletes its app, and exits.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { initializeApp, deleteApp } from "firebase/app";
import { getDatabase, ref, set, get } from "firebase/database";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";

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

const db = getDatabase(app);
const firestore = getFirestore(app);

await outcome("before.database", () => set(ref(db, "server/late"), "before"));
await outcome("before.firestore", () => setDoc(doc(firestore, "server/late"), { at: "before" }));
console.log("late-host waiting");

while (!existsSync("late-host-go")) await delay(100);

await outcome("after.database", async () => {
  await set(ref(db, "server/late"), "after");
  return (await get(ref(db, "server/late"))).val();
});
await outcome("after.firestore", async () => {
  await setDoc(doc(firestore, "server/late"), { at: "after" });
  return (await getDoc(doc(firestore, "server/late"))).data() ?? null;
});
await deleteApp(app);
console.log("late-host done");
