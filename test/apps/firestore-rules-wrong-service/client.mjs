// `node --import @pyric/cli/register client.mjs <id>` writes open/<id> and
// locked/<id> with the client Firestore SDK against the Node host, as a
// server route does. Logs `<name> <code or ok>` per call, deletes its app,
// and exits.
import { initializeApp, deleteApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const id = process.argv[2] ?? "server";
const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
});
const firestore = getFirestore(app);

async function outcome(name, run) {
  try {
    await run();
    console.log(`${name} ok`);
  } catch (error) {
    console.log(`${name} ${error?.code ?? String(error)}`);
  }
}

await outcome("open", () => setDoc(doc(firestore, `open/${id}`), { from: "server" }));
await outcome("locked", () => setDoc(doc(firestore, `locked/${id}`), { from: "server" }));
await deleteApp(app);
console.log("client done");
