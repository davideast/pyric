import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get } from "firebase/database";

const DEFAULT_URL = "https://demo-app-default-rtdb.firebaseio.com";
const SHARD_URL = "https://demo-app-shard-1.firebaseio.com";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: DEFAULT_URL,
});
const auth = getAuth(app);

async function readRoom(url) {
  try {
    const snap = await get(ref(getDatabase(app, url), "rooms/r1"));
    return { allowed: true, exists: snap.exists() };
  } catch (error) {
    return { allowed: false, error: error.message };
  }
}

window.repro = {
  signIn: async () => (await signInAnonymously(auth)).user.uid,
  readRoom: async () => ({
    shard: await readRoom(SHARD_URL),
    default: await readRoom(DEFAULT_URL),
  }),
};
