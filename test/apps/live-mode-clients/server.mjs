// The rooms app's server job. It signs in as the reader and reads a room. Its
// Firebase backend is the project below, or the local backend ROOMS_AUTH_URL
// and ROOMS_FIRESTORE_HOST name, through the SDK's own emulator connectors.
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, terminate } from "firebase/firestore";

const PROJECT = "demo-live-traffic";
const app = initializeApp({ projectId: PROJECT, apiKey: "demo-live-traffic-key", appId: "1:1:web:live-clients", authDomain: `${PROJECT}.firebaseapp.com` });
const auth = getAuth(app);
const db = getFirestore(app);
const authUrl = process.env.ROOMS_AUTH_URL;
const firestoreHost = process.env.ROOMS_FIRESTORE_HOST;
if (authUrl) connectAuthEmulator(auth, authUrl, { disableWarnings: true });
if (firestoreHost) {
  const [host, port] = firestoreHost.split(":");
  connectFirestoreEmulator(db, host, Number(port));
}

const failure = (error) => error.code ?? String(error);
const result = {};
result.uid = await signInWithEmailAndPassword(auth, "reader@example.com", "reader-password").then((credential) => credential.user.uid, failure);
result.read = await getDoc(doc(db, "rooms/lobby")).then((snapshot) => snapshot.data(), failure);

await terminate(db);
await deleteApp(app);
console.log(`RESULT ${JSON.stringify(result)}`);
