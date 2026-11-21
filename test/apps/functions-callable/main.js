import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { doc, getDoc, getFirestore } from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  httpsCallableFromURL,
} from "firebase/functions";

const app = initializeApp({
  apiKey: "demo-callable-key",
  appId: "1:000000000000:web:0000000000000000",
  projectId: "demo-functions-callable",
});

const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "us-central1");

window.runBrowserFlow = async () => {
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  const cred = await signInAnonymously(auth);
  const save = httpsCallable(functions, "saveItem");
  const created = await save({ title: "from browser" });
  const snap = await getDoc(doc(db, "items/" + created.data.id));

  const saveViaRunUrl = httpsCallableFromURL(
    functions,
    "https://saveitem-pyric-uc.a.run.app",
  );
  const viaRun = await saveViaRunUrl({ title: "from run.app" });

  const streamer = httpsCallable(functions, "streamItems");
  const { stream, data: finalData } = await streamer.stream({ count: 2 });
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const streamResult = await finalData;

  const v1Result = await httpsCallable(functions, "legacyEcho")({ ping: "pong" });

  let emptyRejected = null;
  try {
    await save({ title: "" });
  } catch (err) {
    emptyRejected = {
      name: err.name,
      code: err.code,
      details: err.details,
      hasUrl: Boolean(err.customData?.url),
    };
  }

  return {
    uid: cred.user.uid,
    created: created.data,
    stored: snap.data() ?? null,
    viaRun: viaRun.data,
    chunks,
    streamResult,
    v1Result: v1Result.data,
    emptyRejected,
  };
};
