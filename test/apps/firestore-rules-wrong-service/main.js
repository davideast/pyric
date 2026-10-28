import { initializeSandbox } from "pyric/sandbox";
import { inspect, setRules } from "pyric/sandbox/firestore";
import { getFirestore, doc, getDoc, setDoc } from "pyric/firestore";
import { initializeApp } from "firebase/app";
import {
  getFirestore as getHostedFirestore,
  doc as hostedDoc,
  setDoc as setHostedDoc,
} from "firebase/firestore";

// A Storage ruleset that allows everything, set as the in-page sandbox's
// Firestore rules. Production won't load it as Firestore rules.
const STORAGE_ALLOW_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const outcome = (run) => run().then(() => "ok", (error) => `${error?.code ?? "error"}: ${error?.message ?? String(error)}`);

window.wrongService = {
  async run() {
    const sandbox = initializeSandbox();
    setRules(sandbox, STORAGE_ALLOW_ALL);
    const db = getFirestore(sandbox);
    const read = await outcome(() => getDoc(doc(db, "c/1")));
    const write = await outcome(() => setDoc(doc(db, "c/1"), { from: "page" }));
    const status = inspect(sandbox).rules.lint.findings.filter((finding) => finding.rule === "PARSE_ERROR").map((finding) => finding.message);
    return { read, write, status };
  },
};

// The page's Firestore on the Node host (`pyric({ hosted: true })`), through
// the client SDK. Each write answers `ok` or its error code.
const hostedApp = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
});
const hostedFirestore = getHostedFirestore(hostedApp);
const code = (run) => run().then(() => "ok", (error) => error?.code ?? String(error));

window.hostedRules = {
  async write(id) {
    const open = await code(() => setHostedDoc(hostedDoc(hostedFirestore, `open/${id}`), { from: "page" }));
    const locked = await code(() => setHostedDoc(hostedDoc(hostedFirestore, `locked/${id}`), { from: "page" }));
    return { open, locked };
  },
};
