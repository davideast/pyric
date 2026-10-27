import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, onChildAdded, runTransaction } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const database = getDatabase(app);

// Each target is a path whose `.read` a later transaction makes false, and
// the path that transaction writes. `gate` depends on `root`, a room on its
// own `data`.
const targets = {
  gate: { listen: "gate", close: "open" },
  room: { listen: "rooms/r1", close: "rooms/r1/open" },
  roomNotLocal: { listen: "rooms/r2", close: "rooms/r2/open", options: { applyLocally: false } },
};

const events = Object.fromEntries(Object.keys(targets).map((name) => [name, []]));
const markers = [];

window.gate = {
  seed: async () => {
    await set(ref(database, "open"), true);
    await set(ref(database, "gate"), { a: "initial" });
    await set(ref(database, "rooms/r1"), { open: true, a: "initial" });
    await set(ref(database, "rooms/r2"), { open: true, a: "initial" });
  },
  listen: () => {
    for (const [name, target] of Object.entries(targets)) {
      onValue(
        ref(database, target.listen),
        () => events[name].push("value"),
        (error) => events[name].push(`value cancel ${error.code}`),
      );
      onChildAdded(
        ref(database, target.listen),
        (snapshot) => events[name].push(`added ${snapshot.key}`),
        (error) => events[name].push(`added cancel ${error.code}`),
      );
    }
    onValue(ref(database, "marker"), (snapshot) => markers.push(snapshot.val()));
  },
  close: async () => {
    for (const target of Object.values(targets)) {
      await runTransaction(ref(database, target.close), () => false, target.options);
    }
  },
  writeAfter: async () => {
    for (const target of Object.values(targets)) {
      await set(ref(database, `${target.listen}/b`), "post-revocation");
    }
    await set(ref(database, "marker"), 1);
  },
  events: () => events,
  markers: () => markers,
};
