// `node busy-host.mjs` starts while its host is paused and listens to one
// document. It prints the listener's first outcome: its first snapshot, or
// the error that ended it.
import { initializeApp } from "firebase/app";
import { getFirestore, doc, onSnapshot } from "firebase/firestore";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});

const result = await new Promise((resolve) => {
  const stop = onSnapshot(
    doc(getFirestore(app), "server/lifetime"),
    () => {
      stop();
      resolve({ ok: true, value: null });
    },
    (error) => resolve({ ok: false, code: error.code ?? null, message: error.message }),
  );
});
console.log(`busy.listener ${JSON.stringify(result)}`);
process.exit(0);
