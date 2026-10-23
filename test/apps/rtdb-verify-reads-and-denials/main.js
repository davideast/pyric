import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get, onValue, set } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const auth = getAuth(app);
const db = getDatabase(app);

window.repro = {
  signIn: async () => (await signInAnonymously(auth)).user.uid,
  // The owner writes, reads once, and listens to their own profile.
  useOwnProfile: async () => {
    const uid = auth.currentUser.uid;
    await set(ref(db, `profiles/${uid}`), { name: "me" });
    await get(ref(db, `profiles/${uid}`));
    await new Promise((resolve, reject) => {
      const off = onValue(ref(db, `profiles/${uid}`), () => { off(); resolve(); }, reject);
    });
  },
  // Another user's profile: the rules deny the write.
  writeOtherProfile: async () => {
    try {
      await set(ref(db, "profiles/someone-else/name"), "mallory");
      return "allowed";
    } catch (error) {
      return error.code ?? error.message;
    }
  },
};
