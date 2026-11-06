// The app's Firebase init module. It sets up Auth and Firestore and builds a
// document reference, and gets Realtime Database, which live mode serves, and
// Cloud Functions, which passes through, on the same app. None of that sends
// a request.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { doc, getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getFunctions } from "firebase/functions";

const app = initializeApp({
  projectId: "demo-live-sibling",
  apiKey: "demo-live-sibling-key",
  appId: "1:1:web:live-sibling",
  databaseURL: "https://demo-live-sibling-default-rtdb.firebaseio.com",
});
getAuth(app);
const room = doc(getFirestore(app), "rooms/lobby");
const sharesApp = getDatabase(app).app === app && getFunctions(app).app === app;

document.querySelector("#status").textContent = room.path === "rooms/lobby" && sharesApp ? "Ready" : "Broken";
