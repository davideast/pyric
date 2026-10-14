import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, increment as firestoreIncrement } from "firebase/firestore";
import { getDatabase, ref, set, onValue, increment as databaseIncrement } from "firebase/database";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const firestore = getFirestore(app);
const database = getDatabase(app);

let connected = null;
let armed = false;
const outcomes = [];

function record(name, write) {
  const outcome = { name, state: "pending" };
  outcomes.push(outcome);
  write.then(
    () => { outcome.state = "fulfilled"; },
    (error) => { outcome.state = "rejected"; outcome.code = error.code; outcome.message = error.message; },
  );
}

// The hosted client feeds .info/connected from its socket. On the first
// `false` after arm(), the page writes at once, while the client reconnects.
onValue(ref(database, ".info/connected"), (snapshot) => {
  connected = snapshot.val();
  const writesNow = connected === false && armed;
  if (!writesNow) return;
  armed = false;
  record("firestore", setDoc(doc(firestore, "counters/c1"), { n: firestoreIncrement(1) }, { merge: true }));
  record("database", set(ref(database, "counters/c1"), databaseIncrement(1)));
});

window.counters = {
  connected: () => connected,
  arm: () => { outcomes.length = 0; armed = true; },
  outcomes: () => outcomes.map((outcome) => ({ ...outcome })),
};
