// The rooms app's server job. It listens to the lobby until it is stopped.
// Its Firebase backend is the project below, or the local backend
// ROOMS_FIRESTORE_HOST names, through the SDK's own emulator connector.
import { initializeApp } from "firebase/app";
import { connectFirestoreEmulator, doc, getFirestore, onSnapshot } from "firebase/firestore";

const PROJECT = "demo-live-listeners";
const app = initializeApp({ projectId: PROJECT, apiKey: "demo-live-listeners-key", appId: "1:1:web:live-listeners" });
const db = getFirestore(app);
const firestoreHost = process.env.ROOMS_FIRESTORE_HOST;
if (firestoreHost) {
  const [host, port] = firestoreHost.split(":");
  connectFirestoreEmulator(db, host, Number(port));
}

let announced = false;
onSnapshot(doc(db, "rooms/lobby"), (snapshot) => {
  if (announced || snapshot.metadata.fromCache) return;
  announced = true;
  console.log(`LISTENING ${JSON.stringify(snapshot.data())}`);
}, (error) => {
  console.log(`FAILED ${error.code ?? String(error)}`);
  process.exit(1);
});
