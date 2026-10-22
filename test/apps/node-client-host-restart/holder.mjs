// `node holder.mjs` uses the client `firebase/database` SDK from a server
// process that outlives a host restart. It writes holder/0 at once, then
// holder/<n> each time the file `holder-go-<n>` appears (n = 1, 2), and logs
// each outcome as `holder <n> {"ok":...}`. It deletes its app and exits after
// the second.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { initializeApp, deleteApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);

async function write(n) {
  try {
    await set(ref(db, `holder/${n}`), n);
    console.log(`holder ${n} ${JSON.stringify({ ok: true })}`);
  } catch (error) {
    console.log(`holder ${n} ${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })}`);
  }
}

await write(0);
for (const n of [1, 2]) {
  while (!existsSync(`holder-go-${n}`)) await delay(100);
  await write(n);
}
await deleteApp(app);
console.log("holder done");
