import { initializeApp } from "firebase/app";
import { getDatabase, ref, get } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const db = getDatabase(app);

window.readStatus = async () => (await get(ref(db, "status"))).val();
