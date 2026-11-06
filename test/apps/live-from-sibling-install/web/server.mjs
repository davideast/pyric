// The app's server process. It sets up Auth, Firestore and Realtime Database
// on one app object and builds a reference in each database, and gets Cloud
// Functions, which passes through, on the same app. None of that sends a
// request. It prints where
// each import resolved, so the scenario can tell a live row from the
// installed SDK.
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { doc, getFirestore } from "firebase/firestore";
import { getDatabase, ref } from "firebase/database";
import { getFunctions } from "firebase/functions";

const app = initializeApp({
  projectId: "demo-live-sibling",
  apiKey: "demo-live-sibling-key",
  appId: "1:1:web:live-sibling",
  databaseURL: "https://demo-live-sibling-default-rtdb.firebaseio.com",
});
getAuth(app);
const room = doc(getFirestore(app), "rooms/lobby");
const lobby = ref(getDatabase(app), "rooms/lobby");
const functions = getFunctions(app);

const result = {
  firestore: room.path,
  database: lobby.toString(),
  functionsSharesApp: functions.app === app,
  resolved: {
    "firebase/firestore": import.meta.resolve("firebase/firestore"),
    "firebase/database": import.meta.resolve("firebase/database"),
    "firebase/functions": import.meta.resolve("firebase/functions"),
  },
};
await deleteApp(app);
console.log(`RESULT ${JSON.stringify(result)}`);
