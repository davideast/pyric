// Writes as the signed-in page's user through databaseAuthVariableOverride, with
// a custom claim the page's own sign-in does not carry, then as an
// unauthenticated client with a null override.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const uid = process.argv[2];
if (!uid) throw new Error("usage: node server.mjs <uid>");

async function attempt(label, work) {
  try {
    await work();
    console.log(`${label}: allowed`);
  } catch (error) {
    console.log(`${label}: denied (${error.message})`);
  }
}

const asUser = initializeApp(
  { projectId: "demo-app", databaseAuthVariableOverride: { uid, token: { writer: true } } },
  "as-user",
);
await attempt("own note as the user", () => getDatabase(asUser).ref(`notes/${uid}`).set({ text: "from the server" }));
await attempt("another user's note", () => getDatabase(asUser).ref("notes/someone-else").set({ text: "x" }));
await attempt("public as the user", () => getDatabase(asUser).ref("public/greeting").set("hi"));

const signedOut = initializeApp({ projectId: "demo-app", databaseAuthVariableOverride: null }, "signed-out");
await attempt("public signed out", () => getDatabase(signedOut).ref("public/greeting").set("hi"));
await attempt("own note signed out", () => getDatabase(signedOut).ref(`notes/${uid}`).set({ text: "x" }));

const admin = initializeApp({ projectId: "demo-app" }, "admin");
await attempt("anywhere as admin", () => getDatabase(admin).ref("audit/last").set(uid));
process.exit(0);
