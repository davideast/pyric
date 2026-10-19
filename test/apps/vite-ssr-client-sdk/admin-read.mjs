import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";

const tags = process.argv.slice(2);
const app = initializeApp({ projectId: "demo-app", databaseURL: "https://demo-app-default-rtdb.firebaseio.com" });
for (const tag of tags) {
  const rtdb = (await getDatabase(app).ref(`ssr/${tag}`).get()).val();
  const firestore = (await getFirestore(app).doc(`ssr/${tag}`).get()).data() ?? null;
  console.log(`${tag}: ${JSON.stringify({ rtdb, firestore })}`);
}
process.exit(0);
