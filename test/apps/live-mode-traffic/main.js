// A rooms app's page. It signs in, reads a room, lists the open rooms with a
// listener, and opens a room. Its Firebase backend is the project in
// firebase-config.json, or the local backend a `?backend=<origin>` query
// names, through the SDK's own emulator connectors.
import config from "./firebase-config.json";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection, connectFirestoreEmulator, doc, getDoc, getFirestore, onSnapshot, query, setDoc, where,
} from "firebase/firestore";

const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
const backend = new URLSearchParams(location.search).get("backend");
if (backend) {
  const url = new URL(backend);
  connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  connectFirestoreEmulator(db, url.hostname, Number(url.port));
}

const failure = (error) => error.code ?? String(error);
const snapshots = [];
let listening = null;

window.signIn = () =>
  signInWithEmailAndPassword(auth, "reader@example.com", "reader-password").then((credential) => credential.user.uid, failure);

window.readLobby = () =>
  getDoc(doc(db, "rooms/lobby")).then((snapshot) => ({ exists: snapshot.exists(), data: snapshot.data() }), failure);

window.readSecret = () => getDoc(doc(db, "rooms/secret")).then(() => "read", failure);

window.listenToOpenRooms = () => {
  listening ??= new Promise((resolve, reject) => {
    onSnapshot(query(collection(db, "rooms"), where("open", "==", true)), (snapshot) => {
      const rooms = snapshot.docs.map((room) => room.id);
      snapshots.push(rooms);
      document.querySelector("#rooms").innerHTML = rooms.map((room) => `<li>${room}</li>`).join("");
      resolve(rooms);
    }, (error) => reject(failure(error)));
  });
  return listening;
};

window.openGarden = () => setDoc(doc(db, "rooms/garden"), { name: "Garden", open: true }).then(() => "written", failure);

window.openRooms = () => snapshots.at(-1) ?? [];
window.snapshotCount = () => snapshots.length;

/** What each call live mode refuses does: its error, or what it returned. */
const refusedOutcome = (error) => `${error.code}: ${error.message}`;
window.refused = {
  storage: () => import("firebase/storage").then(() => "loaded", refusedOutcome),
  sdkPackage: () => import("@firebase/firestore").then(() => "loaded", refusedOutcome),
  namedDatabase: () => {
    try {
      getFirestore(app, "reports");
      return "opened";
    } catch (error) {
      return refusedOutcome(error);
    }
  },
};

document.querySelector("#status").textContent = "Ready";
