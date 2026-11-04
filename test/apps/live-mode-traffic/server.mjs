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
const fromServer = (snapshot) => !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
let stop = () => {};
let firstAnswer = () => {};
// Production's first answer, before the write: the SDK may first deliver the
// lobby from the cache the earlier read filled, and a write made then would
// reach the listener before production does.
const answered = new Promise((resolve) => { firstAnswer = resolve; });
const patioListed = new Promise((resolve, reject) => {
  const openRooms = query(collection(db, "rooms"), where("open", "==", true));
  stop = onSnapshot(openRooms, { includeMetadataChanges: true }, (snapshot) => {
    const rooms = snapshot.docs.map((room) => room.id);
    listened.push(rooms);
    if (!fromServer(snapshot)) return;
    firstAnswer(rooms);
    if (rooms.includes("patio")) resolve();
  }, (error) => reject(failure(error)));
});
result.answered = await answered;
result.wrote = await setDoc(doc(db, "rooms/patio"), { name: "Patio", open: true }).then(() => "written", failure);
await patioListed;
stop();
result.listened = listened;

await terminate(db);
await deleteApp(app);
console.log(`RESULT ${JSON.stringify(result)}`);
