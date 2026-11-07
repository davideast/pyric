// A server job whose Admin app is set up for another project than the one
// live mode serves: its project, database and bucket. It runs under
// `node --import @pyric/live/register` with the same emulator variables as
// server.mjs, and prints what each call got.
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const app = initializeApp({
  projectId: "other",
  databaseURL: "https://other-default-rtdb.firebaseio.com",
  storageBucket: "other.firebasestorage.app",
});

function codeOf(error) {
  return typeof error?.code === "string" ? error.code : String(error?.message ?? error);
}

const notes = getFirestore(app).collection("pyric_oracle/replay/notes");
const calls = {
  "firestore.get": () => notes.doc("a").get(),
  "firestore.count": () => notes.count().get(),
  "auth.getUser": () => getAuth(app).getUser("user-1"),
  "rtdb.get": () => getDatabase(app).ref("pyric_oracle/replay").get(),
  "storage.exists": () => getStorage(app).bucket().file("pyric_oracle/replay/note.txt").exists(),
};
const results = {};
// The Realtime Database refuses at ref(), before the call, so each call runs inside a promise.
for (const [name, call] of Object.entries(calls)) {
  results[name] = await Promise.resolve().then(call).then(() => "ok", codeOf);
}
console.log(`RESULT ${JSON.stringify(results)}`);
process.exit(0);
