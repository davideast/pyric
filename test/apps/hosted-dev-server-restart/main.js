import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);

window.notes = {
  write: (text) => set(ref(db, "notes/a"), text),
  read: async () => (await get(ref(db, "notes/a"))).val(),
};
