// The app's server process. It sets up Auth, Firestore and Realtime Database
// on one app object and builds a reference in each database, and none of
// that sends a request. It prints where each import resolved, so the
// scenario can tell a live row from the installed SDK.
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { doc, getFirestore } from "firebase/firestore";
import { getDatabase, ref } from "firebase/database";

const app = initializeApp({
  projectId: "demo-live-sibling",
  apiKey: "demo-live-sibling-key",
  appId: "1:1:web:live-sibling",
  databaseURL: "https://demo-live-sibling-default-rtdb.firebaseio.com",
});
getAuth(app);
const room = doc(getFirestore(app), "rooms/lobby");
const lobby = ref(getDatabase(app), "rooms/lobby");

const result = {
  firestore: room.path,
  database: lobby.toString(),
  resolved: {
    "firebase/firestore": import.meta.resolve("firebase/firestore"),
    "firebase/database": import.meta.resolve("firebase/database"),
  },
};
await deleteApp(app);
console.log(`RESULT ${JSON.stringify(result)}`);
