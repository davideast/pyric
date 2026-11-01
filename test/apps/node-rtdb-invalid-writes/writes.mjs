// `node writes.mjs` seeds values with the client SDK, makes writes the SDKs
// refuse, with the client SDK and with firebase-admin, and reads each path
// back with firebase-admin. It logs one line per write,
// `<name> {"threw":...,"message":...,"before":...,"stored":...}`, where before
// and stored are firebase-admin's value and the client SDK's priority.
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

/** `target` names the SDK making the write: the client SDK's ref by default, or firebase-admin's. */
async function attempt(name, path, write, target = ref(db, path)) {
  const before = await exported(path);
  let threw = false;
  let message = null;
  try {
    // A write the SDK refuses throws here; one that returned a promise is awaited so it lands.
    await write(target).catch((error) => { message = `rejected: ${error?.message ?? error}`; });
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
await set(ref(db, "e"), { k: 5 });

await attempt("set.nan", "a", (target) => set(target, NaN));
await attempt("update.nan", "b", (target) => update(target, { k: NaN }));
await attempt("setPriority.nan", "c", (target) => setPriority(target, NaN));
await attempt("set.undefined", "d", (target) => set(target, { k: undefined, j: 1 }));
await attempt("update.array", "b", (target) => update(target, [1]));
await attempt("admin.set.nan", "e", (target) => target.set({ a: NaN }), admin.ref("e"));

// firebase-admin stores integer keys by key and renders them as an array, as production does.
await admin.ref("ticks").set({ 0: "a", 1: "b", 2: "c" });
const ticks = await admin.ref("ticks").get();
console.log(`admin.integerKeys ${JSON.stringify({ val: ticks.val(), isArray: Array.isArray(ticks.val()), exportVal: ticks.exportVal() })}`);

await deleteApp(client);
process.exit(0);
