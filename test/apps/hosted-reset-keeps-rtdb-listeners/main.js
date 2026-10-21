import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const database = getDatabase(app);

const cancels = [];
let unsubscribe = null;

window.counters = {
  write: () => set(ref(database, "counters/c1"), 1),
  listen: () => {
    unsubscribe = onValue(
      ref(database, "counters/c1"),
      () => {},
      (error) => { cancels.push(error.code); }
    );
  },
  cancels: () => cancels,
};
