// `node --import @pyric/cli/register admin-read.mjs <uid>/<tag> ... browser`
// reads, with firebase-admin on the host, what each SSR user wrote under
// users/<uid>/<tag> and what the browser wrote under ssr/browser.
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const app = initializeApp({
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
  storageBucket: "demo-app.appspot.com",
});

async function text(path) {
  const [exists] = await getStorage(app).bucket().file(path).exists();
  if (!exists) return null;
  return (await getStorage(app).bucket().file(path).download())[0].toString();
}

for (const arg of process.argv.slice(2)) {
  if (arg === "browser") {
    const rtdb = (await getDatabase(app).ref("ssr/browser").get()).val();
    const firestore = (await getFirestore(app).doc("ssr/browser").get()).data() ?? null;
    console.log(`browser: ${JSON.stringify({ rtdb, firestore })}`);
    continue;
  }
  const [uid, tag] = arg.split("/");
  const rtdb = (await getDatabase(app).ref(`users/${uid}/${tag}`).get()).val();
  const firestore = (await getFirestore(app).doc(`users/${uid}/notes/${tag}`).get()).data() ?? null;
  const storage = await text(`users/${uid}/${tag}.txt`);
  const other = (await getDatabase(app).ref(`users/someone-else/${tag}`).get()).val();
  console.log(`${tag}: ${JSON.stringify({ rtdb, firestore, storage, other })}`);
}
process.exit(0);
