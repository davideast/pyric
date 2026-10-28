import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
});
const firestore = getFirestore(app);

window.counters = {
  write: () => setDoc(doc(firestore, "counters/c1"), { a: 1 }).then(() => true, (err) => err.code),
};
