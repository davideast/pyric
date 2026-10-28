import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get, onDisconnect } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);

window.addEventListener("pageshow", (event) => {
  window.restoredFromCache = event.persisted;
});

window.presence = {
  goOnline: async (user) => {
    const status = ref(db, `status/${user}`);
    await set(status, "online");
    await onDisconnect(status).set("offline");
  },
  read: async (user) => (await get(ref(db, `status/${user}`))).val(),
};
