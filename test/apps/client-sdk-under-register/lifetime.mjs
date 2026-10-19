// `node lifetime.mjs <case>` uses one client SDK the way a short script does
// and ends without process.exit. An unreferenced 3 s timer logs `held` if the
// process is still up then: it is only up if the SDK holds it, as the
// production SDK would.
//
//   storage    an upload; production holds nothing after it
//   firestore  a write; production releases once the write stream goes idle
//   listener   an open Firestore listener; production holds while it listens
//   rtdb       a write; production holds until goOffline() or deleteApp()
//   offline    a write, then goOffline(); production releases
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, goOffline } from "firebase/database";
import { getFirestore, doc, setDoc, onSnapshot } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});

setTimeout(() => {
  console.log("held");
  process.exit(0);
}, 3_000).unref();

const which = process.argv[2];
if (which === "storage") await uploadString(storageRef(getStorage(app), "server/lifetime.txt"), "x");
if (which === "firestore") await setDoc(doc(getFirestore(app), "server/lifetime"), { at: which });
if (which === "listener") {
  await new Promise((resolve) => onSnapshot(doc(getFirestore(app), "server/lifetime"), resolve));
}
const usesRtdb = which === "rtdb" || which === "offline";
if (usesRtdb) await set(ref(getDatabase(app), "server/lifetime"), which);
if (which === "offline") goOffline(getDatabase(app));
console.log(`${which} done`);
