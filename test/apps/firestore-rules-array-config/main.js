import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-array-config" });
const db = getFirestore(app);

window.tryWrite = async (path, databaseId) => {
  let targetDb = db;
  if (databaseId !== undefined) {
    targetDb = getFirestore(app, databaseId);
  }
  try {
    await setDoc(doc(targetDb, path), { from: "page" });
    return "allowed";
  } catch (error) {
    return `denied: ${error?.code ?? "error"}: ${error?.message ?? String(error)}`;
  }
};

window.tryRead = async (path, databaseId) => {
  let targetDb = db;
  if (databaseId !== undefined) {
    targetDb = getFirestore(app, databaseId);
  }
  try {
    await getDoc(doc(targetDb, path));
    return "allowed";
  } catch (error) {
    return `denied: ${error?.code ?? "error"}: ${error?.message ?? String(error)}`;
  }
};
