// `node client.mjs` uses the client Firebase SDKs from a server process, as a
// script or a server-rendered route does, and logs each outcome on one line:
// `<name> {"ok":true,...}` or `<name> {"ok":false,"code":...}`. It deletes its
// app at the end and then exits on its own, with no process.exit.
import { initializeApp, deleteApp } from "firebase/app";
import { getDatabase, ref, set, get, onValue, onDisconnect } from "firebase/database";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { getStorage, ref as storageRef, uploadString, uploadBytesResumable, getBytes, getDownloadURL } from "firebase/storage";
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

await outcome("auth.createUser", async () =>
  (await createUserWithEmailAndPassword(getAuth(app), "node@example.com", "secret123")).user.uid);
const user = getAuth(app).currentUser;
// Rules that allow the upload's create and deny every delete: the cancel
// still rejects storage/canceled and leaves no object, as production stores
// nothing for a canceled upload (#1157).
await outcome("storage.cancelCreateOnly", () => cancelAfterLastSlice("uploads/a.png"));
await outcome("database.ownPath", () => set(ref(db, `users/${user?.uid}`), "mine"));
await outcome("database.otherPath", () => set(ref(db, "users/someone-else"), "theirs"));
await outcome("database.onDisconnect", () => onDisconnect(ref(db, "server/presence")).set("gone"));
await outcome("database.presence", () => set(ref(db, "server/presence"), "here"));

await outcome("ai", async () => (await import("firebase/ai")).getAI(app));
await outcome("messaging", async () => (await import("firebase/messaging")).getMessaging(app));
await outcome("functions", async () => (await httpsCallable(getFunctions(app), "hello")({})).data);

await outcome("deleteApp", () => deleteApp(app));
console.log("client done");
