import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, onDisconnect } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const database = getDatabase(app);
const status = ref(database, "status/alice");

let connected = null;
let connections = 0;
let rearms = true;
const arms = [];

// The presence code from the Firebase docs: each time the client connects,
// queue the disconnect write, then mark the user online. With re-arm off, the
// page arms only on its first connection, as an app that never re-arms would.
function arm() {
  const entry = { state: "pending" };
  arms.push(entry);
  onDisconnect(status).set("offline")
    .then(() => set(status, "online"))
    .then(
      () => { entry.state = "fulfilled"; },
      (error) => { entry.state = "rejected"; entry.message = `${error.code}: ${error.message}`; },
    );
}

onValue(ref(database, ".info/connected"), (snapshot) => {
  connected = snapshot.val();
  if (connected === true) connections += 1;
  const armsNow = connected === true && (rearms || arms.length === 0);
  if (armsNow) arm();
});

window.presence = {
  connected: () => connected,
  connections: () => connections,
  setRearm: (value) => { rearms = value; },
  arms: () => arms.map((entry) => ({ ...entry })),
};
