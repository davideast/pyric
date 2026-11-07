// The rooms app's module service worker. When the page asks, it signs in as
// the writer, so its own call reaches production from the service worker.
// Its backend is the project below, or the local backend the `?backend=`
// query on its script URL names, through the SDK's own emulator connector.
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from "firebase/auth";

const PROJECT = "demo-live-traffic";
const app = initializeApp({
  projectId: PROJECT,
  apiKey: "demo-live-traffic-key",
  appId: "1:1:web:live-clients",
  authDomain: `${PROJECT}.firebaseapp.com`,
});
const auth = getAuth(app);
const backend = new URL(self.location.href).searchParams.get("backend");
if (backend) connectAuthEmulator(auth, new URL(backend).origin, { disableWarnings: true });

const failure = (error) => error.code ?? String(error);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data !== "sign-in") return;
  const signedIn = signInWithEmailAndPassword(auth, "writer@example.com", "writer-password").then((credential) => credential.user.uid, failure);
  event.waitUntil(signedIn.then((uid) => event.source.postMessage({ uid })));
});
