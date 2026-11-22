// A package of the app's own that imports client firebase/app, firebase/auth,
// and firebase/database (#1143). Copied into node_modules so Vite externalizes
// it by default under dev SSR and Node resolves its Firebase imports directly;
// under ssr.noExternal: true Vite routes its imports to the hosted sandbox.
import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, get } from "firebase/database";

const config = {
  apiKey: "demo-key",
  appId: "1:1:web:1",
  authDomain: "demo-app.firebaseapp.com",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
  storageBucket: "demo-app.appspot.com",
};

export async function writeAndReadClient(tag) {
  const app = getApps()[0] ?? initializeApp(config);
  const auth = getAuth(app);
  const uid = auth.currentUser?.uid ?? (await signInAnonymously(auth)).user.uid;
  const db = getDatabase(app);
  await set(ref(db, `users/${uid}/${tag}`), { from: "local-client-lib" });
  return (await get(ref(db, `users/${uid}/${tag}`))).val();
}
