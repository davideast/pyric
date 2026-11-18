import { initializeApp } from "firebase/app";
import { getDatabase, ref, get } from "firebase/database";
import { getFirestore, doc, getDoc, collection, getAggregateFromServer, count } from "firebase/firestore";
import { getStorage, ref as storageRef, deleteObject } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);
const firestore = getFirestore(app);
const storage = getStorage(app);

window.readBack = async () => ({
  database: (await get(ref(db, "server/client"))).val(),
  firestore: (await getDoc(doc(firestore, "server/client"))).data() ?? null,
  // server/late, server/fromAdmin, server/client and server/cjs (from client.cjs) exist by now.
  aggregate: (await getAggregateFromServer(collection(firestore, "server"), { n: count() })).data(),
  storageDeleteMissing: await deleteObject(storageRef(storage, "server/never-existed.txt")).then(
    () => "ok",
    (error) => error.code,
  ),
  storageDeleteDeniedMissing: await deleteObject(storageRef(storage, "uploads/never-existed.png")).then(
    () => "ok",
    (error) => error.code,
  ),
});
