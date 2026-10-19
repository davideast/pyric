// `node admin.mjs` reads, with firebase-admin on the Node host, the paths
// client.mjs tried to write, and logs each outcome on one line.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const app = initializeApp({
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

await outcome("admin.database", async () => (await getDatabase(app).ref("server/client").get()).val());
await outcome("admin.firestore", async () => (await getFirestore(app).doc("server/client").get()).data() ?? null);
await outcome("admin.auth", async () => (await getAuth(app).listUsers()).users.map((user) => user.email));
await outcome("admin.storage", async () => (await getStorage(app).bucket().file("server/client.txt").exists())[0]);
process.exit(0);
