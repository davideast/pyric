// Seeds the user documents the Storage rules read, with firebase-admin, as a
// server script of the app would.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const app = initializeApp({ projectId: "demo-app", storageBucket: "demo-app.appspot.com" });
const db = getFirestore(app);
for (const path of process.argv.slice(2)) {
  await db.doc(path).set({ admin: true });
}
await getStorage(app).bucket().file("seeded/capture-s.bin").save(Buffer.from([1, 2, 3, 4, 5, 6]), {
  contentType: "application/octet-stream",
});
console.log("seeded");
process.exit(0);
