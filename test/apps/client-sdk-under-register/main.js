import { initializeApp } from "firebase/app";
import { getDatabase, ref, get } from "firebase/database";
import { getFirestore, doc, getDoc } from "firebase/firestore";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);
const firestore = getFirestore(app);

window.readBack = async () => ({
  database: (await get(ref(db, "server/client"))).val(),
  firestore: (await getDoc(doc(firestore, "server/client"))).data() ?? null,
});
