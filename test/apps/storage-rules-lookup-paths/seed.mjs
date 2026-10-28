// Seeds the user documents the Storage rules read, with firebase-admin, as a
// server script of the app would.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore(initializeApp({ projectId: "demo-app" }));
for (const path of process.argv.slice(2)) {
  await db.doc(path).set({ admin: true });
}
console.log("seeded");
process.exit(0);
