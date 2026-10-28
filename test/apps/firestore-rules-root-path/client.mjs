// `node --import @pyric/cli/register client.mjs` writes and reads c/1 with
// the client Firestore SDK against the Node host, as a server route does.
// Logs `<name> <code or ok>` per call, deletes its app, and exits.
import { initializeApp, deleteApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

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

await outcome("write", () => setDoc(doc(firestore, "c/1"), { from: "server" }));
await outcome("read", () => getDoc(doc(firestore, "c/1")));
await deleteApp(app);
console.log("client done");
