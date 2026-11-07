// The notes app's server job. With the Admin SDK it manages a user and checks
// an ID token, then reads and writes notes in Firestore, the Realtime
// Database and Cloud Storage, as a full-stack app's server half does. It runs
// under `node --import @pyric/live/register`, and reaches its backend through
// firebase-admin's own emulator variables, which the scenario points at a
// local stand-in for production. It prints what each call got.
import { generateKeyPairSync, sign } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const PROJECT = process.env.NOTES_PROJECT;
const RUN = "pyric_oracle/replay";
const EMAIL = "admin-capture@example.com";
const TEXT = "capture text";

const app = initializeApp({
  projectId: PROJECT,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
  storageBucket: `${PROJECT}.firebasestorage.app`,
});
const auth = getAuth(app);
const db = getFirestore(app);
const database = getDatabase(app);
const bucket = getStorage(app).bucket();

/** What a call got: "ok", or its error's code. */
function codeOf(error) {
  const code = error?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : String(error?.message ?? error);
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

const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The ID token a page signed in as `uid` sends, as the Auth emulator issues one: unsigned. */
function pageIdToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, iat: now, exp: now + 3600, sub: uid, user_id: uid };
  return `${segment({ alg: "none", typ: "JWT" })}.${segment(claims)}.`;
}

/** An ID token a pyric sandbox issued: RS256 with the sandbox's key id. */
function sandboxIdToken(uid) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const header = segment({ alg: "RS256", kid: "pyric-sandbox", typ: "JWT" });
  const payload = segment({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, sub: uid, user_id: uid, iat: now, exp: now + 3600 });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// Auth
let uid = "";
let idToken = "";
await step("auth.createUser", async () => {
  uid = (await auth.createUser({ email: EMAIL, password: "notes-password" })).uid;
  idToken = pageIdToken(uid);
});
await step("auth.verifyIdToken", () => auth.verifyIdToken(idToken));
await step("auth.verifyIdToken-checkRevoked", () => auth.verifyIdToken(idToken, true));
await step("auth.getUser", () => auth.getUser(uid));
await step("auth.getUserByEmail", () => auth.getUserByEmail(EMAIL));
await step("auth.setCustomUserClaims", () => auth.setCustomUserClaims(uid, { role: "capture" }));
await step("auth.updateUser", () => auth.updateUser(uid, { displayName: "Capture" }));
await step("auth.revokeRefreshTokens", () => auth.revokeRefreshTokens(uid));
await step("auth.verifyIdToken-revoked", () => auth.verifyIdToken(idToken, true));
let sandboxRefusal = null;
await step("auth.verifyIdToken-sandbox-token", () => auth.verifyIdToken(sandboxIdToken(uid)).catch((error) => {
  sandboxRefusal = error.pyricCode ?? null;
  throw error;
}));
await step("auth.deleteUser", () => auth.deleteUser(uid));
await step("auth.getUser-deleted", () => auth.getUser(uid));

// Firestore
const notes = db.collection(`${RUN}/notes`);
const a = notes.doc("a");
const missing = notes.doc("missing");
let added = "";
let counted = null;
await step("firestore.set", () => a.set({ n: 1 }));
await step("firestore.get", async () => check((await a.get()).exists, "the note does not exist"));
await step("firestore.get-missing", async () => check(!(await missing.get()).exists, "the missing note exists"));
await step("firestore.update", () => a.update({ n: 2 }));
await step("firestore.update-missing", () => missing.update({ n: 2 }));
await step("firestore.create-existing", () => a.create({ n: 1 }));
await step("firestore.add", async () => { added = (await notes.add({ n: 3 })).id; });
await step("firestore.query", async () => check((await notes.where("n", ">=", 1).get()).size === 2, "the query did not see two notes"));
await step("firestore.count", async () => { counted = (await notes.count().get()).data().count; });
await step("firestore.getAll", () => db.getAll(a, notes.doc(added)));
await step("firestore.batch", () => db.batch().set(notes.doc("c"), { n: 5 }).update(a, { batched: true }).commit());
await step("firestore.runTransaction", () => db.runTransaction(async (transaction) => {
  const snapshot = await transaction.get(a);
  transaction.update(a, { n: snapshot.get("n") + 1 });
}));
await step("firestore.onSnapshot", () => new Promise((resolve, reject) => {
  let snapshots = 0;
  const unsubscribe = notes.onSnapshot((snapshot) => {
    snapshots += 1;
    if (snapshots === 1) {
      notes.doc("d").set({ n: 4 }).catch(reject);
      return;
    }
    if (snapshot.docChanges().length === 0) return;
    unsubscribe();
    resolve();
  }, reject);
}));
await step("firestore.delete", () => a.delete());

// Realtime Database
const run = database.ref(RUN);
await step("rtdb.set", () => run.set({ a: 1 }));
await step("rtdb.get", async () => check((await run.get()).exists(), "the run path is empty"));
await step("rtdb.update", () => run.update({ b: 2 }));
await step("rtdb.push", async () => { await run.child("list").push({ c: 3 }); });
await step("rtdb.transaction", async () => check((await run.child("counter").transaction((n) => (n ?? 0) + 1)).committed, "the transaction did not commit"));
await step("rtdb.on-value", () => new Promise((resolve, reject) => {
  const watched = run.child("watch");
  let values = 0;
  const listener = watched.on("value", () => {
    values += 1;
    if (values === 1) {
      watched.set(1).catch(reject);
      return;
    }
    watched.off("value", listener);
    resolve();
  }, reject);
}));
await step("rtdb.once-missing", async () => check((await run.child("missing").once("value")).val() === null, "the missing path has a value"));
await step("rtdb.remove", () => run.remove());

// Cloud Storage
const note = bucket.file(`${RUN}/note.txt`);
await step("storage.save", () => note.save(TEXT, { resumable: false, contentType: "text/plain" }));
await step("storage.getMetadata", () => note.getMetadata());
await step("storage.exists", async () => check((await note.exists())[0], "the note does not exist"));
await step("storage.download", async () => check((await note.download())[0].toString() === TEXT, "the download differs"));
await step("storage.getFiles", async () => check((await bucket.getFiles({ prefix: `${RUN}/` }))[0].length === 1, "the prefix does not hold one file"));
await step("storage.setMetadata", () => note.setMetadata({ metadata: { capture: "admin" } }));
await step("storage.download-missing", () => bucket.file(`${RUN}/missing.txt`).download());
await step("storage.delete", () => note.delete());

// A service live mode does not serve.
await step("securityRules.import", () => import("firebase-admin/security-rules"));

await database.goOffline();
console.log(`RESULT ${JSON.stringify({ results, sandboxRefusal, counted })}`);
process.exit(0);
