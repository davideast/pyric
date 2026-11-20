import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get, set } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const auth = getAuth(app);
const db = getDatabase(app);

async function attempt(work) {
  try {
    return { allowed: true, value: await work() };
  } catch (error) {
    return { allowed: false, error: error.message };
  }
}

window.repro = {
  signIn: async () => (await signInAnonymously(auth)).user.uid,
  readNote: () => attempt(async () => (await get(ref(db, `notes/${auth.currentUser.uid}`))).val()),
  writeNote: () => attempt(() => set(ref(db, `notes/${auth.currentUser.uid}`), { text: "from the page" })),
};
