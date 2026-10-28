// `node writes.mjs` seeds values with the client SDK, makes writes the SDK
// refuses, and reads each path back with firebase-admin. It logs one line per
// write, `<name> {"threw":...,"message":...,"before":...,"stored":...}`, where
// before and stored are firebase-admin's value and the client SDK's priority.
// firebase-admin under pyric does not model priorities, so the client reads it.
import { initializeApp as initializeClient, deleteApp } from "firebase/app";
import { getDatabase, ref, get, set, update, setPriority, setWithPriority } from "firebase/database";
import { initializeApp as initializeAdmin } from "firebase-admin/app";
import { getDatabase as getAdminDatabase } from "firebase-admin/database";

const config = { projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" };
const client = initializeClient({ apiKey: "demo", appId: "demo", ...config });
const db = getDatabase(client);
const admin = getAdminDatabase(initializeAdmin(config));

async function exported(path) {
  const value = (await admin.ref(path).get()).val();
  const priority = (await get(ref(db, path))).priority;
  return { value, priority };
}

async function attempt(name, path, write) {
  const before = await exported(path);
  let threw = false;
  let message = null;
  try {
    // A write the SDK refuses throws here; one that returned a promise is awaited so it lands.
    await write(ref(db, path)).catch((error) => { message = `rejected: ${error?.message ?? error}`; });
  } catch (error) {
    threw = true;
    message = String(error?.message ?? error);
  }
  const stored = await exported(path);
  console.log(`${name} ${JSON.stringify({ threw, message, before, stored })}`);
}

await set(ref(db, "a"), 1);
await set(ref(db, "b"), { k: 5, j: 1 });
await setWithPriority(ref(db, "c"), 5, 3);
await set(ref(db, "d"), { k: 5 });

await attempt("set.nan", "a", (target) => set(target, NaN));
await attempt("update.nan", "b", (target) => update(target, { k: NaN }));
await attempt("setPriority.nan", "c", (target) => setPriority(target, NaN));
await attempt("set.undefined", "d", (target) => set(target, { k: undefined, j: 1 }));
await attempt("update.array", "b", (target) => update(target, [1]));

await deleteApp(client);
process.exit(0);
