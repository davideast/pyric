import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-array-config" });
const db = getFirestore(app);

window.tryWrite = async (path) => {
  try {
    await setDoc(doc(db, path), { from: "page" });
    return "allowed";
  } catch (error) {
    return `denied: ${error?.code ?? "error"}: ${error?.message ?? String(error)}`;
  }
};
