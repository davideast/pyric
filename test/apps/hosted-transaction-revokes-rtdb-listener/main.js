import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, onChildAdded, runTransaction } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const database = getDatabase(app);

const events = [];
const markers = [];

window.gate = {
  seed: async () => {
    await set(ref(database, "open"), true);
    await set(ref(database, "gate"), { a: "initial" });
  },
  listen: () => {
    onValue(
      ref(database, "gate"),
      (snapshot) => events.push(`value ${JSON.stringify(snapshot.val())}`),
      (error) => events.push(`value cancel ${error.code}`),
    );
    onChildAdded(
      ref(database, "gate"),
      (snapshot) => events.push(`added ${snapshot.key}`),
      (error) => events.push(`added cancel ${error.code}`),
    );
    onValue(ref(database, "marker"), (snapshot) => markers.push(snapshot.val()));
  },
  close: () => runTransaction(ref(database, "open"), () => false),
  writeAfter: async () => {
    await set(ref(database, "gate/b"), "post-revocation");
    await set(ref(database, "marker"), 1);
  },
  events: () => events,
  markers: () => markers,
};
