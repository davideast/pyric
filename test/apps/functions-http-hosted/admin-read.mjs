// `node --import @pyric/cli/register admin-read.mjs <id> ...` reads, with
// firebase-admin on the host, each messages/<id> document a function wrote,
// and prints one `<id>: <json>` line per document.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app = initializeApp({ projectId: "demo-functions-http" });

for (const id of process.argv.slice(2)) {
  const data = (await getFirestore(app).doc(`messages/${id}`).get()).data() ?? null;
  console.log(`${id}: ${JSON.stringify(data)}`);
}
process.exit(0);
