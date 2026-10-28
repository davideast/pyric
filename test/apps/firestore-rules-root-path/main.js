import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
});
const firestore = getFirestore(app);

const outcome = (run) => run().then(() => "ok", (error) => error?.code ?? String(error));

window.rootPath = {
  write: () => outcome(() => setDoc(doc(firestore, "c/1"), { from: "page" })),
  read: () => outcome(() => getDoc(doc(firestore, "c/1"))),
};
