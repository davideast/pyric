// `node host-move.mjs` writes through its host, then waits while the
// scenario stops that host and starts the project's host again on another
// port, which rewrites .pyric/serve.json. Once the file `host-move-go`
// appears, the same apps write and read again: the client SDKs must find the
// moved host, as firebase-admin in the same process does. Logs
// `<name> {"ok":...}` per call, deletes its apps, and exits.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { initializeApp, deleteApp } from "firebase/app";
import { getDatabase, ref, set, get } from "firebase/database";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { initializeApp as initializeAdminApp, deleteApp as deleteAdminApp } from "firebase-admin/app";
import { getDatabase as getAdminDatabase } from "firebase-admin/database";

const config = {
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
};
const app = initializeApp(config);
const admin = initializeAdminApp({ projectId: config.projectId, databaseURL: config.databaseURL });

async function outcome(name, run) {
  try {
    console.log(`${name} ${JSON.stringify({ ok: true, value: (await run()) ?? null })}`);
  } catch (error) {
    console.log(`${name} ${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })}`);
  }
}

const db = getDatabase(app);
const firestore = getFirestore(app);
const adminDb = getAdminDatabase(admin);

async function round(phase) {
  await outcome(`${phase}.database`, async () => {
    await set(ref(db, "server/move"), phase);
    return (await get(ref(db, "server/move"))).val();
  });
  await outcome(`${phase}.firestore`, async () => {
    await setDoc(doc(firestore, "server/move"), { at: phase });
    return (await getDoc(doc(firestore, "server/move"))).data() ?? null;
  });
  await outcome(`${phase}.admin`, async () => {
    await adminDb.ref("server/moveAdmin").set(phase);
    return (await adminDb.ref("server/moveAdmin").get()).val();
  });
}

await round("first");
console.log("host-move waiting");

while (!existsSync("host-move-go")) await delay(100);

await round("moved");
await deleteApp(app);
await deleteAdminApp(admin);
console.log("host-move done");
