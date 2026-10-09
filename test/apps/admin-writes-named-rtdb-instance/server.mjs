import { initializeApp } from "firebase-admin/app";
import { getDatabaseWithUrl } from "firebase-admin/database";

const DEFAULT_URL = "https://demo-app-default-rtdb.firebaseio.com";
const SHARD_URL = "https://demo-app-shard-1.firebaseio.com";
const uid = process.argv[2];
if (!uid) throw new Error("usage: node server.mjs <uid>");

const app = initializeApp({ projectId: "demo-app", databaseURL: DEFAULT_URL });
await getDatabaseWithUrl(SHARD_URL, app)
  .ref("rooms/r1")
  .set({ title: "Room 1", members: { [uid]: true } });
console.log(`created rooms/r1 on ${SHARD_URL} for ${uid}`);

// Read back through each URL with admin privileges.
for (const [label, url] of [["shard", SHARD_URL], ["default", DEFAULT_URL]]) {
  const snap = await getDatabaseWithUrl(url, app).ref("rooms/r1").get();
  console.log(`admin read via ${label} URL: exists=${snap.exists()}`);
}
process.exit(0);
