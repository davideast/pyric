// `node room.mjs` prints the value the page writes at rooms/r1.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
const room = (await getDatabase(app).ref("rooms/r1").get()).val();
console.log(`room ${JSON.stringify(room)}`);
process.exit(0);
