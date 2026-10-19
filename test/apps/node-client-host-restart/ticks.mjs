// `node ticks.mjs` prints the tick numbers the host stores under ticks/.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
// The keys are numbers, so `val()` may return an array whose missing ticks
// are holes or nulls. Tick n stores n, so a stored tick is a key whose value
// equals it.
const value = (await getDatabase(app).ref("ticks").get()).val() ?? {};
const stored = Object.entries(value)
  .filter(([key, tick]) => tick === Number(key))
  .map(([key]) => Number(key))
  .sort((a, b) => a - b);
console.log(`ticks ${JSON.stringify(stored)}`);
process.exit(0);
