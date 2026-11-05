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
// The documents production billed the listener for: each document a snapshot
// changed, at least one for the first, none for a metadata-only snapshot.
let billedDocuments = 0;
let listening = null;

window.signIn = () =>
  signInWithEmailAndPassword(auth, "reader@example.com", "reader-password").then((credential) => credential.user.uid, failure);

window.readLobby = () =>
  getDoc(doc(db, "rooms/lobby")).then((snapshot) => ({ exists: snapshot.exists(), data: snapshot.data() }), failure);

window.readSecret = () => getDoc(doc(db, "rooms/secret")).then(() => "read", failure);

window.listenToOpenRooms = () => {
  listening ??= new Promise((resolve, reject) => {
    // Resolves with production's first answer, not a snapshot from the cache
    // or one holding a write still on its way.
    onSnapshot(query(collection(db, "rooms"), where("open", "==", true)), { includeMetadataChanges: true }, (snapshot) => {
      const rooms = snapshot.docs.map((room) => room.id);
      const changed = snapshot.docChanges().length;
      billedDocuments += snapshots.length === 0 ? Math.max(changed, 1) : changed;
      snapshots.push(rooms);
      document.querySelector("#rooms").innerHTML = rooms.map((room) => `<li>${room}</li>`).join("");
      const fromServer = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
      if (fromServer) resolve(rooms);
    }, (error) => reject(failure(error)));
  });
  return listening;
};

window.openGarden = () => setDoc(doc(db, "rooms/garden"), { name: "Garden", open: true }).then(() => "written", failure);

window.openRooms = () => snapshots.at(-1) ?? [];
/** How many times the listener's callback ran. */
window.deliveryCount = () => snapshots.length;
window.billedDocumentCount = () => billedDocuments;

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
  // The SDK file the live rows loaded, read back from the page's resource
  // timings and imported again under another URL that reaches the same file:
  // a second copy of the raw SDK, which would open a named database the rows
  // refuse. `t` adds a timestamp query, `amp` a trailing `&`, and
  // `encodedName` spells the `v` query name as `%76`. `absolute` and `id`
  // name the file by its absolute path under `root`, the app's directory, as
  // itself and behind `/@id/`; their `Query` forms add a query.
  cacheBusted: async (variant = "t", root = "") => {
    const loaded = performance.getEntriesByType("resource").map((entry) => entry.name)
      .find((name) => /\/@firebase\/firestore\/dist\/index\.esm\.js/.test(name));
    if (loaded === undefined) return "no loaded SDK file";
    const [path, query = ""] = loaded.split("?");
    const urls = {
      t: `${path}?${query}${query ? "&" : ""}t=${Date.now()}`,
      amp: `${path}?${query}&`,
      encodedName: `${path}?${query.replace(/^v=/, "%76=")}`,
      absolute: `${root}${new URL(path).pathname}`,
      absoluteQuery: `${root}${new URL(path).pathname}?z=1`,
      id: `/@id${root}${new URL(path).pathname}`,
      idQuery: `/@id${root}${new URL(path).pathname}?q=1`,
    };
    const busted = urls[variant];
    try {
      const raw = await import(/* @vite-ignore */ busted);
      raw.initializeFirestore(app, {}, "reports");
      return "opened";
    } catch (error) {
      return refusedOutcome(error);
    }
  },
};

document.querySelector("#status").textContent = "Ready";
