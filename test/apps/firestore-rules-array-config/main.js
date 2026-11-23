import { deleteApp, initializeApp } from "firebase/app";
import {
  arrayRemove,
  collection,
  doc,
  getDoc,
  getDocFromCache,
  getDocs,
  getFirestore,
  increment,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  startAfter,
} from "firebase/firestore";

const appOptions = { apiKey: "demo", appId: "demo", projectId: "demo-array-config" };
const app = initializeApp(appOptions);
const db = getFirestore(app);
let parityAppSeq = 0;

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

window.verifyNamedDbAndCacheParity = async () => {
  const freshApp = initializeApp(appOptions, `parity-${++parityAppSeq}`);
  let unsub;
  try {
    const freshDefault = getFirestore(freshApp);
    const freshReports = getFirestore(freshApp, "reports");
    const watched = [];
    unsub = onSnapshot(doc(freshReports, "open/watched"), (snap) => {
      watched.push(snap.exists());
    });
    await getDoc(doc(freshDefault, "open/a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsub();
    unsub = undefined;

    await setDoc(doc(freshReports, "open/c1"), { rank: 1 });
    await setDoc(doc(freshReports, "open/c2"), { rank: 2 });
    const cursorSnap = await getDoc(doc(freshReports, "open/c1"));
    const pageSnap = await getDocs(
      query(collection(freshReports, "open"), orderBy("rank", "asc"), startAfter(cursorSnap)),
    );
    const cursorIds = pageSnap.docs.map((d) => d.id);

    await setDoc(doc(freshDefault, "open/transform"), {
      tags: ["keep", "drop"],
      count: 3,
      stale: true,
    });
    await setDoc(doc(freshDefault, "open/transform"), {
      tags: arrayRemove("drop"),
      count: increment(2),
    });
    const cachedSnap = await getDocFromCache(doc(freshDefault, "open/transform"));

    return {
      initialListenerEvents: watched.length,
      cursorIds,
      cachedData: cachedSnap.data(),
    };
  } finally {
    unsub?.();
    await deleteApp(freshApp);
  }
};
