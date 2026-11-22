// `node client.mjs` uses the client Firebase SDKs from a server process, as a
// script or a server-rendered route does, and logs each outcome on one line:
// `<name> {"ok":true,...}` or `<name> {"ok":false,"code":...}`. It deletes its
// app at the end and then exits on its own, with no process.exit.
import { initializeApp, deleteApp } from "firebase/app";
import { getDatabase, ref, set, get, onValue, onDisconnect, runTransaction } from "firebase/database";
import { getFirestore, doc, setDoc, getDoc, collection, query, limit, onSnapshot, serverTimestamp, deleteField, increment, Timestamp, getAggregateFromServer, count, sum, average } from "firebase/firestore";
import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { getStorage, ref as storageRef, uploadString, uploadBytesResumable, getBytes, getMetadata, getDownloadURL, deleteObject } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";

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

// The first call of the process: the upload is issued before the connection
// has attached, so it must wait for the host's byte route, not send frames.
const upload = outcome("storage.upload", async () =>
  (await uploadString(storageRef(getStorage(app), "server/client.txt"), "from client sdk")).metadata.fullPath);
await upload;
await outcome("storage.url", async () => new URL(await getDownloadURL(storageRef(getStorage(app), "server/client.txt"))).pathname);
await outcome("storage.deleteMissing", () => deleteObject(storageRef(getStorage(app), "server/never-existed.txt")));
await outcome("storage.deleteDeniedMissing", () => deleteObject(storageRef(getStorage(app), "uploads/never-existed.png")));

// A resumable upload canceled once its last request is on the wire: that
// request cannot be recalled, so the task rejects only after the object it
// stored is deleted, and a read after the rejection finds nothing (#1137).
async function cancelAfterLastSlice(path) {
  const target = storageRef(getStorage(app), path);
  const task = uploadBytesResumable(target, new TextEncoder().encode("canceled upload"));
  task.on("state_changed", (snapshot) => {
    const allSent = snapshot.state === "running" && snapshot.bytesTransferred === snapshot.totalBytes;
    if (allSent) queueMicrotask(() => task.cancel());
  });
  const rejected = await task.then(() => "stored", (error) => error.code);
  const readBack = await getBytes(target).then(() => "present", (error) => error.code);
  return { rejected, readBack };
}
await outcome("storage.cancelAfterLastSlice", () => cancelAfterLastSlice("server/canceled.txt"));

const db = getDatabase(app);
await outcome("database.set", () => set(ref(db, "server/client"), "from client sdk"));
await outcome("database.get", async () => (await get(ref(db, "server/fromAdmin"))).val());
await outcome("database.connected", () =>
  new Promise((resolve) => onValue(ref(db, ".info/connected"), (snap) => resolve(snap.val()), { onlyOnce: true })));
await outcome("firestore.setDoc", () => setDoc(doc(getFirestore(app), "server/client"), { from: "client sdk" }));
await outcome("firestore.getDoc", async () => (await getDoc(doc(getFirestore(app), "server/fromAdmin"))).data() ?? null);
function encodeAggregate(data) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      out[key] = String(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// server/late, server/fromAdmin and server/client exist by now.
await outcome("firestore.aggregate", async () =>
  (await getAggregateFromServer(collection(getFirestore(app), "server"), { n: count() })).data());

const fsDb = getFirestore(app);
await setDoc(doc(fsDb, "server/agg/sparse/a"), { x: 1, y: 10 });
await setDoc(doc(fsDb, "server/agg/sparse/b"), { x: 2 });
await setDoc(doc(fsDb, "server/agg/sparse/c"), { y: 6 });
await setDoc(doc(fsDb, "server/agg/nan/1"), { v: 1 });
await setDoc(doc(fsDb, "server/agg/nan/2"), { v: Number.NaN });
await setDoc(doc(fsDb, "server/agg/nan/3"), { v: 2 });
await setDoc(doc(fsDb, "server/agg/inf/1"), { v: 1 });
await setDoc(doc(fsDb, "server/agg/inf/2"), { v: Number.POSITIVE_INFINITY });
await outcome("firestore.aggregateSemantics", async () => ({
  countAndSumY: encodeAggregate(
    (await getAggregateFromServer(collection(fsDb, "server/agg/sparse"), { n: count(), sy: sum("y") })).data(),
  ),
  nan: encodeAggregate(
    (await getAggregateFromServer(collection(fsDb, "server/agg/nan"), { s: sum("v"), a: average("v"), n: count() })).data(),
  ),
  inf: encodeAggregate(
    (await getAggregateFromServer(collection(fsDb, "server/agg/inf"), { s: sum("v"), a: average("v"), n: count() })).data(),
  ),
}));

await outcome("firestore.warmedCacheMerge", async () => {
  const target = doc(fsDb, "writeOnly/d1");
  await setDoc(target, {
    type: "custom",
    meta: { a: 1, drop: "x" },
    stamped: new Timestamp(1_600_000_000, 999_999_999),
  });
  await setDoc(
    target,
    { label: "merged", meta: { b: 2, drop: deleteField() } },
    { merge: true },
  );
  return await new Promise((resolve) => {
    let firstSnap = null;
    const unsub = onSnapshot(
      target,
      (snap) => {
        const data = snap.data() ?? {};
        firstSnap = {
          type: data.type ?? null,
          label: data.label ?? null,
          meta: data.meta ?? null,
          stampedSeconds: data.stamped instanceof Timestamp ? data.stamped.seconds : null,
          stampedNanos: data.stamped instanceof Timestamp ? data.stamped.nanoseconds : null,
        };
      },
      (error) => {
        unsub();
        resolve({ snap: firstSnap, errorCode: error?.code ?? null });
      },
    );
  });
});

await outcome("firestore.removedServerTimestamp", async () => {
  const col = collection(fsDb, "server/tsEvict/items");
  let initialReady;
  const initialDone = new Promise((resolve) => { initialReady = resolve; });
  let addedReady;
  const addedDone = new Promise((resolve) => { addedReady = resolve; });
  let removedReady;
  const removedDone = new Promise((resolve) => { removedReady = resolve; });
  const unsub = onSnapshot(query(col, limit(1)), (snap) => {
    initialReady();
    for (const change of snap.docChanges()) {
      if (change.type === "added" && change.doc.id === "b") addedReady();
      if (change.type === "removed" && change.doc.id === "b") {
        removedReady({
          id: change.doc.id,
          isTimestamp: change.doc.data()?.stamped instanceof Timestamp,
        });
      }
    }
  });
  await initialDone;
  await setDoc(doc(col, "b"), { stamped: serverTimestamp() });
  await addedDone;
  await setDoc(doc(col, "a"), { stamped: serverTimestamp() });
  const result = await removedDone;
  unsub();
  return result;
});

await outcome("auth.createUser", async () =>
  (await createUserWithEmailAndPassword(getAuth(app), "node@example.com", "secret123")).user.uid);
const user = getAuth(app).currentUser;
// Rules that allow the upload's create and deny every delete: the cancel
// still rejects storage/canceled and leaves no object, as production stores
// nothing for a canceled upload (#1157).
await outcome("storage.cancelCreateOnly", () => cancelAfterLastSlice("uploads/a.png"));
// The same cancel over an object already at the path: the earlier object
// stays, bytes and metadata, as production never replaced it (#1159).
async function cancelOverwrite(path) {
  const target = storageRef(getStorage(app), path);
  const earlier = await uploadString(target, "v1", "raw", { contentType: "text/plain", customMetadata: { version: "one" } });
  const { rejected } = await cancelAfterLastSlice(path);
  const text = new TextDecoder().decode(await getBytes(target));
  const after = await getMetadata(target);
  const sameGeneration = after.generation === earlier.metadata.generation;
  return { rejected, text, customMetadata: after.customMetadata, sameGeneration };
}
await outcome("storage.cancelOverwrite", () => cancelOverwrite("uploads/b.txt"));
await outcome("database.ownPath", () => set(ref(db, `users/${user?.uid}`), "mine"));
await outcome("database.otherPath", () => set(ref(db, "users/someone-else"), "theirs"));
await outcome("database.onDisconnect", () => onDisconnect(ref(db, "server/presence")).set("gone"));
await outcome("database.presence", () => set(ref(db, "server/presence"), "here"));

const uid = user?.uid ?? "missing";
const profileRef = ref(db, `userProfiles/${uid}`);
await set(profileRef, { created: true });
const counterDocRef = doc(fsDb, `userDocs/${uid}/items/d1`);
let liveInitialReady;
const liveInitialDone = new Promise((resolve) => { liveInitialReady = resolve; });
let liveIncrementReady;
const liveIncrementDone = new Promise((resolve) => { liveIncrementReady = resolve; });
const unsubLiveCounter = onSnapshot(counterDocRef, (snap) => {
  if (!snap.exists()) {
    liveInitialReady();
    return;
  }
  if (snap.data()?.n === 2) {
    liveIncrementReady();
  }
});
await liveInitialDone;
await setDoc(counterDocRef, { label: "pinned", n: increment(2) }, { merge: true });
await liveIncrementDone;
unsubLiveCounter();

await signOut(getAuth(app));

await outcome("database.revokedWarmCreateOnlyTxn", async () => {
  const result = await runTransaction(profileRef, (cur) => (cur === null ? { created: false } : undefined));
  return { committed: result.committed, val: result.snapshot.val() };
});

await outcome("firestore.liveListenerIncrementCache", () =>
  new Promise((resolve) => {
    let cachedDocs = null;
    const unsub = onSnapshot(
      collection(fsDb, `userDocs/${uid}/items`),
      (snap) => {
        cachedDocs = snap.docs.map((d) => d.data());
      },
      (error) => {
        unsub();
        resolve({ docs: cachedDocs, errorCode: error?.code ?? null });
      },
    );
  }));

await outcome("ai", async () => (await import("firebase/ai")).getAI(app));
await outcome("messaging", async () => (await import("firebase/messaging")).getMessaging(app));
await outcome("functions", async () => (await httpsCallable(getFunctions(app), "hello")({})).data);

await outcome("deleteApp", () => deleteApp(app));
console.log("client done");
