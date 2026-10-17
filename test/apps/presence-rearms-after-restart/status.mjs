// `node status.mjs` prints the presence status the page keeps at status/alice.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
const status = (await getDatabase(app).ref("status/alice").get()).val();
console.log(`status ${JSON.stringify(status)}`);
process.exit(0);
