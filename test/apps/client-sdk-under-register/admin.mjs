// `node admin.mjs seed` writes server/fromAdmin on the Node host with
// firebase-admin; `node admin.mjs` reads back what the client SDKs wrote.
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

if (process.argv[2] === "seed") {
  await outcome("admin.seed.database", () => getDatabase(app).ref("server/fromAdmin").set("from admin"));
  await outcome("admin.seed.firestore", () => getFirestore(app).doc("server/fromAdmin").set({ from: "admin" }));
} else {
  const db = getDatabase(app);
  const user = await getAuth(app).getUserByEmail("node@example.com").catch(() => null);
  await outcome("admin.database", async () => (await db.ref("server/client").get()).val());
  await outcome("admin.firestore", async () => (await getFirestore(app).doc("server/client").get()).data() ?? null);
  await outcome("admin.auth", async () => user?.email ?? null);
  await outcome("admin.ownPath", async () => (await db.ref(`users/${user?.uid}`).get()).val());
  await outcome("admin.otherPath", async () => (await db.ref("users/someone-else").get()).val());
  await outcome("admin.presence", async () => (await db.ref("server/presence").get()).val());
  await outcome("admin.storage", async () => (await getStorage(app).bucket().file("server/client.txt").download())[0].toString());
  await outcome("admin.cjs", async () => (await db.ref("server/cjs").get()).val());
}
process.exit(0);
