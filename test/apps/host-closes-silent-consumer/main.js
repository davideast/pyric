import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);

window.observer = {
  read: async (path) => (await get(ref(db, path))).val(),
  write: (path, value) => set(ref(db, path), value),
};
