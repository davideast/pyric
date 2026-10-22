// A page whose Firebase config names another storage bucket than holder.mjs,
// a key that picks backend data. holder.mjs sent its config first, so this
// page is the one refused, even when it loads after a host restart.
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "other-bucket.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});

window.conflict = {
  async write() {
    try {
      await set(ref(getDatabase(app), "conflict/page"), true);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  },
};
