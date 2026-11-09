// Node backend running under `node --import @pyric/live/register`. Exercises
// firebase-admin/firestore and firebase-admin/database reads, writes, merges,
// listeners, projections, batches, getAll, push, filtered queries, and both
// committed and rolled-back transactions against the offline replay server via
// firebase-admin's own emulator environment variables.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT = process.env.ORDERS_PROJECT;

const app = initializeApp({
  projectId: PROJECT,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
});
const db = getFirestore(app);
const database = getDatabase(app);

function codeOf(error) {
  const code = error?.code;
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  return String(error?.message ?? error);
}

const results = {};
async function step(name, run) {
  try {
    await run();
    results[name] = "ok";
  } catch (error) {
    results[name] = codeOf(error);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const orders = db.collection("orders");
const ord1 = orders.doc("ord-1");
const ord2 = orders.doc("ord-2");
const ordCreated = orders.doc("ord-created");
const ordMerge = orders.doc("ord-merge");
const ordTemp = orders.doc("ord-temp");
const ordBatch = orders.doc("ord-batch");
const ordStale = orders.doc("ord-stale");
const ordMissing = orders.doc("ord-missing");

let addedId = "";
let pushedKey = "";

// Firestore Admin calls
await step("firestore.set", () =>
  ord1.set({ status: "queued", total: 42, apiKey: "secret-order-key" }),
);
await step("firestore.get", async () => {
  const snap = await ord1.get();
  check(snap.exists, "ord-1 does not exist");
});
await step("firestore.get-missing", async () => {
  const snap = await ordMissing.get();
  check(!snap.exists, "ord-missing should not exist");
});
await step("firestore.create", () =>
  ordCreated.create({ status: "created", total: 12 }),
);
await step("firestore.merge", async () => {
  await ordMerge.set({ status: "base", total: 20 });
  await ordMerge.set({ tier: "gold" }, { merge: true });
  await ordMerge.set({ status: "merged", ignored: "drop" }, { mergeFields: ["status"] });
});
await step("firestore.delete", async () => {
  await ordTemp.set({ status: "temp", total: 5 });
  await ordTemp.delete();
});
await step("firestore.update", () =>
  ord1.update({ priority: 2, status: "processing" }),
);
await step("firestore.update-missing", () =>
  ordMissing.update({ status: "never" }),
);
await step("firestore.add", async () => {
  const ref = await orders.add({ status: "added", total: 15 });
  addedId = ref.id;
});
await step("firestore.getAll", async () => {
  const snaps = await db.getAll(ord2, ordStale);
  check(snaps.length === 2 && snaps[0].exists && !snaps[1].exists, "unexpected getAll snapshots");
});
await step("firestore.batch", () =>
  db
    .batch()
    .set(ordBatch, { status: "batched", total: 10 })
    .delete(ordStale)
    .commit(),
);
await step("firestore.query", async () => {
  const snap = await orders.where("total", ">=", 10).get();
  check(snap.size === 1, "expected 1 queried order");
});
await step("firestore.onSnapshot", () =>
  new Promise((resolve, reject) => {
    let deliveries = 0;
    const stop = orders.where("status", "==", "live").onSnapshot((snap) => {
      deliveries += 1;
      if (deliveries === 1) {
        orders.doc("ord-live-2").set({ status: "live", total: 35 }).catch(reject);
        return;
      }
      if (snap.docChanges().length === 0) return;
      stop();
      resolve();
    }, reject);
  }),
);
await step("firestore.tx-commit", () =>
  db.runTransaction(async (tx) => {
    const snap = await tx.get(ord1);
    tx.update(ord1, {
      previousStatus: snap.get("status"),
      status: "fulfilled",
    });
  }),
);
await step("firestore.select", async () => {
  const snap = await orders.select("status").get();
  check(snap.size === 1, "expected 1 projected order");
});
await step("firestore.tx-rollback", () =>
  db.runTransaction(async (tx) => {
    await tx.get(ord2);
    tx.update(ord2, { status: "rolled-back" });
    throw new Error("abort-tx");
  }),
);

// Realtime Database Admin calls
await step("rtdb.set", () =>
  database.ref("queues/q-1").set({ state: "ready", workers: 2 }),
);
await step("rtdb.update", () =>
  database.ref("queues/q-1").update({ region: "us", workers: 3 }),
);
await step("rtdb.setWithPriority", () =>
  database.ref("queues/priority-q").setWithPriority({ state: "prio" }, 10),
);
await step("rtdb.remove", async () => {
  await database.ref("queues/temp-q").set({ state: "ephemeral" });
  await database.ref("queues/temp-q").remove();
});
await step("rtdb.push", async () => {
  const pushed = database.ref("queues/items").push({ job: "sync" });
  pushedKey = pushed.key ?? "";
  await pushed;
});
await step("rtdb.get", async () => {
  const snap = await database.ref("queues/extra").get();
  check(snap.exists(), "queues/extra should exist");
});
await step("rtdb.filtered-get", async () => {
  await database.ref("queues/by-region").set({
    east: { region: "east" },
    west: { region: "west" },
  });
  const snap = await database
    .ref("queues/by-region")
    .orderByChild("region")
    .equalTo("west")
    .get();
  check(snap.exists(), "filtered query should match west");
});
await step("rtdb.once", async () => {
  const snap = await database.ref("queues/once-q").once("value");
  check(snap.val()?.state === "once-read", "expected once-read value");
});
await step("rtdb.on", () =>
  new Promise((resolve, reject) => {
    const watched = database.ref("queues/watch-q");
    let count = 0;
    const cb = watched.on("value", () => {
      count += 1;
      if (count === 1) {
        watched.set({ step: 2 }).catch(reject);
        return;
      }
      watched.off("value", cb);
      resolve();
    }, reject);
  }),
);
await step("rtdb.tx-commit", async () => {
  const outcome = await database.ref("counters/processed").transaction((n) => (n ?? 0) + 1);
  check(outcome.committed, "counter transaction did not commit");
});
await step("rtdb.tx-abort", async () => {
  const outcome = await database.ref("counters/aborted").transaction(() => undefined);
  check(!outcome.committed, "aborted transaction should not commit");
});

await database.goOffline();
console.log(`RESULT ${JSON.stringify({ results, addedId, pushedKey })}`);
process.exit(0);
