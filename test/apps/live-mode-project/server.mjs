// The rooms app's server job, with the page's two Firebase apps: the default
// one on the project the live host serves, and a second one whose config
// names another project. It signs in on the first, then each reads the lobby.
// Their backend is the local one ROOMS_AUTH_URL and ROOMS_FIRESTORE_HOST
// name, through the SDK's own emulator connectors.
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, terminate } from "firebase/firestore";

const config = (projectId) => ({
  projectId,
  apiKey: `${projectId}-key`,
  appId: `1:1:web:${projectId}`,
  authDomain: `${projectId}.firebaseapp.com`,
});
const host = initializeApp(config("demo-live-traffic"));
const other = initializeApp(config("demo-live-other"), "other");
const auth = getAuth(host);
connectAuthEmulator(auth, process.env.ROOMS_AUTH_URL, { disableWarnings: true });
const databases = { host: getFirestore(host), other: getFirestore(other) };
const [firestoreHost, firestorePort] = process.env.ROOMS_FIRESTORE_HOST.split(":");
for (const db of Object.values(databases)) connectFirestoreEmulator(db, firestoreHost, Number(firestorePort));

/** What a call settled with: its value, or its error's code and message. */
const settle = (call) => Promise.resolve().then(call).then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, code: error.code ?? String(error), message: error.message }),
);
const readLobby = (name) => settle(() => getDoc(doc(databases[name], "rooms/lobby")).then((snapshot) => snapshot.data() ?? null));

const result = {};
result.signIn = await settle(() => signInWithEmailAndPassword(auth, "writer@example.com", "writer-password").then((credential) => credential.user.uid));
result.host = await readLobby("host");
result.other = await readLobby("other");

await Promise.all(Object.values(databases).map((db) => terminate(db)));
await Promise.all([deleteApp(host), deleteApp(other)]);
console.log(`RESULT ${JSON.stringify(result)}`);
