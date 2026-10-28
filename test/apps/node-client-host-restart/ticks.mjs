// `node ticks.mjs` prints the tick numbers the host stores under ticks/.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
// The keys are numbers, so `val()` may render ticks/ as an array. The
// snapshot still has one child per stored tick, keyed '0', '1', ... (#1110).
// Tick n stores n, so a stored tick is a child whose value equals its key.
const snapshot = await getDatabase(app).ref("ticks").get();
const stored = [];
snapshot.forEach((tick) => {
  if (tick.val() === Number(tick.key)) stored.push(Number(tick.key));
});
console.log(`ticks ${JSON.stringify(stored)}`);
process.exit(0);
