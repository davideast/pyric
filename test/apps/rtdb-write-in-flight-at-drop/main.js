import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, onDisconnect } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const database = getDatabase(app);

let connected = null;
let connections = 0;
let write = { state: "idle" };
let arm = { state: "idle" };
const rejections = [];

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  rejections.push(`${reason?.code ?? "no code"}: ${reason?.message ?? String(reason)}`);
});

onValue(ref(database, ".info/connected"), (snapshot) => {
  connected = snapshot.val();
  if (connected === true) connections += 1;
});

window.calls = {
  connected: () => connected,
  connections: () => connections,
  // A write the page handles, and the presence sample's onDisconnect, which
  // the Firebase docs call without a rejection handler.
  issue() {
    write = { state: "pending" };
    set(ref(database, "rooms/r1"), "written across the drop").then(
      () => { write.state = "fulfilled"; },
      (error) => { write.state = "rejected"; write.message = `${error.code}: ${error.message}`; },
    );
    arm = { state: "pending" };
    onDisconnect(ref(database, "status/alice")).set("offline").then(() => { arm.state = "fulfilled"; });
  },
  outcomes: () => ({ write: { ...write }, arm: { ...arm } }),
  rejections: () => [...rejections],
};
