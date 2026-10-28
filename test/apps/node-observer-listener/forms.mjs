// `node forms.mjs` listens with the other observer forms production accepts
// and logs one line per case: `<name> <json>`. It also logs any uncaught
// exception, so a listener that throws out of the connection shows up here.
// - doc.observer: `{ next, error }` on c/b, then a write to c/b.
// - query.observer: `{ next, error }` on collection c, then a write to c/q.
// - doc.optionsObserver: `(options, { next })` on c/o.
// - denied.nextOnly: `{ next }` alone on closed/x, which the rules deny; the
//   SDK logs the error once and nothing throws.
// - after.write: a write once the denied listen has settled, to show the
//   connection still answers.
import { initializeApp } from "firebase/app";
import { getFirestore, doc, collection, onSnapshot, setDoc } from "firebase/firestore";

process.on("uncaughtException", (error) => console.log(`uncaught exception ${String(error?.stack ?? error)}`));
process.on("unhandledRejection", (reason) => console.log(`unhandled rejection ${String(reason?.stack ?? reason)}`));

const db = getFirestore(initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await sleep(50);
}

function timed(promise) {
  return Promise.race([promise.then(() => "resolved"), sleep(10_000).then(() => "pending after 10s")]);
}

{
  const ref = doc(db, "c/b");
  const seen = [];
  const errors = [];
  const stop = onSnapshot(ref, { next: (s) => seen.push(s.exists()), error: (e) => errors.push(e?.code ?? String(e)) });
  await until(() => seen.length >= 1);
  const write = await timed(setDoc(ref, { n: 1 }));
  await until(() => seen.length >= 2);
  stop();
  console.log(`doc.observer ${JSON.stringify({ seen, errors, write })}`);
}

{
  const seen = [];
  const stop = onSnapshot(collection(db, "c"), { next: (s) => seen.push(s.docs.map((d) => d.id)), error: () => {} });
  await until(() => seen.length >= 1);
  const before = seen.length;
  const write = await timed(setDoc(doc(db, "c/q"), { n: 1 }));
  await until(() => seen.length > before);
  stop();
  console.log(`query.observer ${JSON.stringify({ last: seen.at(-1), write })}`);
}

{
  const seen = [];
  const stop = onSnapshot(doc(db, "c/o"), { includeMetadataChanges: true }, { next: (s) => seen.push(s.exists()) });
  await until(() => seen.length >= 1);
  stop();
  console.log(`doc.optionsObserver ${JSON.stringify({ seen })}`);
}

{
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map((arg) => String(arg?.code ?? arg)).join(" "));
  const stop = onSnapshot(doc(db, "closed/x"), { next: () => {} });
  await until(() => logged.length >= 1);
  await sleep(300);
  console.error = original;
  stop();
  const reported = logged.filter((line) => line.includes("Uncaught Error in snapshot listener")).length;
  console.log(`denied.nextOnly ${JSON.stringify({ reported, denied: logged.some((line) => line.includes("permission-denied")) })}`);
}

console.log(`after.write ${JSON.stringify(await timed(setDoc(doc(db, "c/after"), { n: 1 })))}`);
console.log("forms done");
process.exit(0);
