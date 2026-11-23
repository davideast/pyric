// Exercises firebase-admin/firestore Query count, select, cursors, offset,
// stream, withConverter, CollectionReference.listDocuments, and deferred
// CollectionGroup.getPartitions against the Node host (#1774).
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app = initializeApp({
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});

async function outcome(name, run) {
  try {
    console.log(`${name} ${JSON.stringify({ ok: true, value: (await run()) ?? null })}`);
  } catch (error) {
    console.log(
      `${name} ${JSON.stringify({
        ok: false,
        code: error?.code ?? null,
        message: String(error?.message ?? error),
      })}`,
    );
  }
}

const db = getFirestore(app);
const col = db.collection("adminQueryParity");

await col.doc("a").set({ rank: 10, label: "alpha", secret: "s1" });
await col.doc("b").set({ rank: 20, label: "beta", secret: "s2" });
await col.doc("c").set({ rank: 30, label: "gamma", secret: "s3" });
await col.doc("phantom").collection("nested").doc("leaf").set({ v: 1 });

await outcome("admin.query.count", async () => {
  const snap = await col.count().get();
  return {
    data: snap.data(),
    readTimeIsNumber:
      typeof snap.readTime?.seconds === "number" &&
      typeof snap.readTime?.nanoseconds === "number",
    queryMatches: snap.query.isEqual(col),
    selfEqual: snap.isEqual(snap),
  };
});

await outcome("admin.query.select", async () => {
  const snap = await col.orderBy("rank").select("label").get();
  return {
    size: snap.size,
    empty: snap.empty,
    hasReadTime: typeof snap.readTime?.toMillis === "function",
    docs: snap.docs.map((d) => ({
      id: d.id,
      exists: d.exists,
      data: d.data(),
      secret: d.get("secret") ?? null,
    })),
  };
});

await outcome("admin.query.cursor", async () => {
  const snap = await col.orderBy("rank").startAfter(10).limit(1).get();
  const first = snap.docs[0];
  return {
    size: snap.size,
    empty: snap.empty,
    ids: snap.docs.map((d) => d.id),
    firstData: first ? first.data() : null,
    hasDocTimestamps:
      typeof first?.createTime?.toMillis === "function" &&
      typeof first?.updateTime?.toMillis === "function" &&
      typeof first?.readTime?.toMillis === "function",
  };
});

await outcome("admin.query.offset", async () => {
  const snap = await col.orderBy("rank").offset(1).get();
  const countSnap = await col.orderBy("rank").offset(1).count().get();
  return {
    size: snap.size,
    ids: snap.docs.map((d) => d.id),
    offsetCount: countSnap.data(),
  };
});

await outcome("admin.query.stream", async () => {
  const eventStream = col.orderBy("rank").stream();
  const isReadable =
    typeof eventStream.on === "function" && typeof eventStream.pipe === "function";
  const eventIds = [];
  let allSnapsHaveRefAndReadTime = true;
  await new Promise((resolve, reject) => {
    eventStream.on("data", (docSnap) => {
      eventIds.push(docSnap.id);
      if (
        typeof docSnap.ref?.path !== "string" ||
        typeof docSnap.readTime?.toMillis !== "function"
      ) {
        allSnapsHaveRefAndReadTime = false;
      }
    });
    eventStream.on("end", () => resolve());
    eventStream.on("error", (err) => reject(err));
  });

  const asyncIterIds = [];
  for await (const docSnap of col.orderBy("rank").stream()) {
    asyncIterIds.push(docSnap.id);
  }

  return {
    isReadable,
    eventIds,
    asyncIterIds,
    allSnapsHaveRefAndReadTime,
  };
});

await outcome("admin.query.discoveryAndDeferred", async () => {
  const typed = col.withConverter({
    toFirestore: (val) => val,
    fromFirestore: (snap) => {
      const d = snap.data();
      return `${String(d.label).toUpperCase()}:${String(d.rank)}`;
    },
  });
  const refs = await typed.listDocuments();
  const listedIds = refs.map((r) => r.id);
  const existsById = {};
  for (const r of refs) {
    existsById[r.id] = (await r.get()).exists;
  }
  const convertedBeta = (await typed.doc("b").get()).data() ?? null;
  let deferredName = null;
  try {
    db.collectionGroup("nested").getPartitions(2);
  } catch (err) {
    deferredName = err?.name ?? null;
  }
  return {
    listedIds,
    existsById,
    convertedBeta,
    deferredName,
  };
});

process.exit(0);
