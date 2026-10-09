import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "my-app-staging",
  databaseURL: "https://my-app-staging-main.firebaseio.com",
});
const db = getDatabase(app);

window.tryWrite = async (path) => {
  try {
    await set(ref(db, path), true);
    return "allowed";
  } catch (error) {
    return `denied: ${error.message}`;
  }
};
