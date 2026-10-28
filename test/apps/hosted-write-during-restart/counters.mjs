// `node counters.mjs seed` sets both counters to 0; with no argument it reads them.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

const command = process.argv[2];
const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
const counter = getFirestore(app).doc("counters/c1");
const node = getDatabase(app).ref("counters/c1");

if (command === "seed") {
  await counter.set({ n: 0 });
  await node.set(0);
}
const firestore = (await counter.get()).data()?.n ?? null;
const database = (await node.get()).val();
console.log(`counters ${JSON.stringify({ firestore, database })}`);
process.exit(0);
