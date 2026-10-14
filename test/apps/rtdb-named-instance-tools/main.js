import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get, set } from "firebase/database";

const SHARD_URL = "https://shard-00.firebaseio.com";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const auth = getAuth(app);
const databases = { default: getDatabase(app), shard: getDatabase(app, SHARD_URL) };

async function read(database, path) {
  const snap = await get(ref(database, path));
  return snap.val();
}

window.repro = {
  signIn: async () => (await signInAnonymously(auth)).user.uid,
  writeLobbies: async () => {
    await set(ref(databases.default, "rooms/lobby"), { name: "default lobby" });
    await set(ref(databases.shard, "rooms/lobby"), { name: "shard lobby" });
  },
  read: async (path) => ({
    default: await read(databases.default, path),
    shard: await read(databases.shard, path),
  }),
};
