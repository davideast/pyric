// `node plain.mjs` is the report's script (#1358): a plain app with no process
// error handlers listens to c/a with an observer that has `next` alone, then
// writes c/a. In production the observer sees the missing doc, then the
// write, and the process keeps running. It logs what the observer saw and
// whether the write resolved, then exits 0.
import { initializeApp } from "firebase/app";
import { getFirestore, doc, onSnapshot, setDoc } from "firebase/firestore";

const db = getFirestore(initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ref = doc(db, "c/a");
const seen = [];

const stop = onSnapshot(ref, { next: (snapshot) => seen.push(snapshot.exists()) });
console.log("plain subscribed");
const write = await Promise.race([
  setDoc(ref, { n: 1 }).then(() => "resolved"),
  sleep(10_000).then(() => "pending after 10s"),
]);
console.log(`plain write ${write}`);
const deadline = Date.now() + 10_000;
while (seen.length < 2 && Date.now() < deadline) await sleep(50);
console.log(`plain seen ${JSON.stringify(seen)}`);
stop();
process.exit(0);
