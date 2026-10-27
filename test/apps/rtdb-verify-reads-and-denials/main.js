import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get, onDisconnect, onValue, set, update } from "firebase/database";

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
  // Presence: the owner registers what to write when the connection ends.
  registerPresence: async () => {
    await onDisconnect(ref(db, `presence/${auth.currentUser.uid}`)).set("offline");
  },
  // One update to the owner's profile and another user's: the rules deny it as one request.
  updateBothProfiles: async () => {
    try {
      await update(ref(db), { [`profiles/${auth.currentUser.uid}/name`]: "me again", "profiles/someone-else/name": "mallory" });
      return "allowed";
    } catch (error) {
      return error.code ?? error.message;
    }
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
