// The app's Firebase init module: one file that sets up every service the
// app uses on one app object. Its backend is production, or the local one a
// `?backend=<origin>` query names, through the SDK's own emulator connectors
// and the model's `baseUrl`. The local backend answers AI Logic on the
// GoogleAI backend's path, so the model uses that backend.
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectDatabaseEmulator, getDatabase } from "firebase/database";
import { getMessaging } from "firebase/messaging";
import { connectStorageEmulator, getStorage } from "firebase/storage";

const PROJECT = "demo-live-2113";

export const app = initializeApp({
  projectId: PROJECT,
  apiKey: "demo-live-2113-key",
  appId: "1:1:web:live-2113",
  messagingSenderId: "1",
  authDomain: `${PROJECT}.firebaseapp.com`,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
  storageBucket: `${PROJECT}.firebasestorage.app`,
});

const backend = new URLSearchParams(location.search).get("backend");
const url = backend ? new URL(backend) : null;

export const auth = getAuth(app);
export const db = getDatabase(app);
export const storage = getStorage(app);
export const messaging = getMessaging(app);
export const model = getGenerativeModel(
  getAI(app, { backend: new GoogleAIBackend() }),
  { model: "gemini-flash-lite-latest" },
  url ? { baseUrl: url.origin } : undefined,
);

if (url) {
  connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  connectDatabaseEmulator(db, url.hostname, Number(url.port));
  connectStorageEmulator(storage, url.hostname, Number(url.port));
}
