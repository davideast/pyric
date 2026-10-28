import { initializeSandbox } from "pyric/sandbox";
import { inspect, setRules } from "pyric/sandbox/firestore";
import { getFirestore, doc, getDoc, setDoc } from "pyric/firestore";

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
