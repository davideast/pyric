// The app's Firebase init module. It sets up Auth and Firestore and builds a
// document reference, and none of that sends a request.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { doc, getFirestore } from "firebase/firestore";

const app = initializeApp({ projectId: "demo-live-sibling", apiKey: "demo-live-sibling-key", appId: "1:1:web:live-sibling" });
getAuth(app);
const room = doc(getFirestore(app), "rooms/lobby");

document.querySelector("#status").textContent = room.path === "rooms/lobby" ? "Ready" : "Broken";
