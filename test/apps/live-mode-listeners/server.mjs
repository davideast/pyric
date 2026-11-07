// The rooms app's server job. It renders the halls list and listens to the lobby until it is stopped.
// Its Firebase backend is the project below, or the local backend
// ROOMS_FIRESTORE_HOST names, through the SDK's own emulator connector.
import { initializeApp } from "firebase/app";
import { collection, connectFirestoreEmulator, doc, getFirestore, onSnapshot } from "firebase/firestore";

const PROJECT = "demo-live-listeners";
const app = initializeApp({ projectId: PROJECT, apiKey: "demo-live-listeners-key", appId: "1:1:web:live-listeners" });
const db = getFirestore(app);
const firestoreHost = process.env.ROOMS_FIRESTORE_HOST;
if (firestoreHost) {
  const [host, port] = firestoreHost.split(":");
  connectFirestoreEmulator(db, host, Number(port));
}

// Renders the halls list for the page: its first answer from the backend, as
// snapshot JSON the page resumes. A browser SDK cannot write a query
// snapshot's bundle, so a server renders it.
const stopHalls = onSnapshot(collection(db, "halls"), (snapshot) => {
  if (snapshot.metadata.fromCache) return;
  stopHalls();
  console.log(`HALLS ${JSON.stringify(snapshot.toJSON())}`);
}, (error) => {
  console.log(`FAILED ${error.code ?? String(error)}`);
  process.exit(1);
});

let announced = false;
onSnapshot(doc(db, "rooms/lobby"), (snapshot) => {
  if (announced || snapshot.metadata.fromCache) return;
  announced = true;
  console.log(`LISTENING ${JSON.stringify(snapshot.data())}`);
}, (error) => {
  console.log(`FAILED ${error.code ?? String(error)}`);
  process.exit(1);
});
