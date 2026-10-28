// `PYRIC_SANDBOX=local node --import @pyric/cli/register write.mjs` writes
// with the client SDK, as a script or a server-rendered route does, and logs
// each outcome on one line: `<path> allowed` or `<path> denied: <code>`.
import { initializeApp, deleteApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-array-config" });
const db = getFirestore(app);

for (const path of ["open/a", "locked/x"]) {
  try {
    await setDoc(doc(db, path), { from: "server" });
    console.log(`${path} allowed`);
  } catch (error) {
    console.log(`${path} denied: ${error?.code ?? "error"}`);
  }
}
await deleteApp(app);
