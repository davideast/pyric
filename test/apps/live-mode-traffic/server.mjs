// The rooms app's server job. It signs in as its own account, reads a room,
// lists the open rooms with a listener, is denied the secret room, and opens
// a room. Its Firebase backend is the project in firebase-config.json, or the
// local backend ROOMS_AUTH_URL and ROOMS_FIRESTORE_HOST name, through the
// SDK's own emulator connectors.
import { readFileSync } from "node:fs";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection, connectFirestoreEmulator, doc, getDoc, getFirestore, onSnapshot, query, setDoc, terminate, where,
} from "firebase/firestore";

const config = JSON.parse(readFileSync(new URL("./firebase-config.json", import.meta.url), "utf8"));
const app = initializeApp(config);
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
result.uid = await signInWithEmailAndPassword(auth, "writer@example.com", "writer-password").then((credential) => credential.user.uid, failure);
result.read = await getDoc(doc(db, "rooms/lobby")).then((snapshot) => snapshot.data(), failure);
result.denied = await getDoc(doc(db, "rooms/secret")).then(() => "read", failure);

const listened = [];
let stop = () => {};
const patioListed = new Promise((resolve, reject) => {
  stop = onSnapshot(query(collection(db, "rooms"), where("open", "==", true)), (snapshot) => {
    const rooms = snapshot.docs.map((room) => room.id);
    listened.push(rooms);
    if (rooms.includes("patio")) resolve();
  }, (error) => reject(failure(error)));
});
// The listener's first snapshot, before the write.
while (listened.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
result.wrote = await setDoc(doc(db, "rooms/patio"), { name: "Patio", open: true }).then(() => "written", failure);
await patioListed;
stop();
result.listened = listened;

await terminate(db);
await deleteApp(app);
console.log(`RESULT ${JSON.stringify(result)}`);
