// `node writer.mjs <ticks>` writes ticks/<n> = n with firebase-admin's
// Database every 100 ms, `<ticks>` times, and logs each outcome as one line:
// `tick {"n":3,"issuedAt":...,"settledAt":...,"ok":true}`, or on a failure
// `"ok":false` with the error's `code` and `message`. It exits once every
// write has settled.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

process.on("unhandledRejection", (reason) => console.log(`unhandled rejection ${String(reason?.stack ?? reason)}`));
process.on("uncaughtException", (error) => console.log(`uncaught exception ${String(error?.stack ?? error)}`));

const ticks = Number(process.argv[2] ?? 100);
const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
const db = getDatabase(app);

function write(n) {
  const issuedAt = Date.now();
  const log = (fields) => console.log(`tick ${JSON.stringify({ n, issuedAt, settledAt: Date.now(), ...fields })}`);
  return db.ref(`ticks/${n}`).set(n).then(
    () => log({ ok: true }),
    (error) => log({ ok: false, code: error?.code ?? null, message: error?.message ?? String(error) }),
  );
}

const writes = [];
for (let n = 0; n < ticks; n++) {
  writes.push(write(n));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await Promise.all(writes);
console.log("writer done");
process.exit(0);
