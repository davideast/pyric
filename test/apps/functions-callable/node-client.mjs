import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { doc, getDoc, getFirestore } from "firebase/firestore";
import { getFunctions, httpsCallable, httpsCallableFromURL } from "firebase/functions";

const app = initializeApp({
  apiKey: "demo-callable-key",
  appId: "1:000000000000:web:0000000000000000",
  projectId: "demo-functions-callable",
});

try {
  const cred = await signInAnonymously(getAuth(app));
  const functions = getFunctions(app, "us-central1");
  const created = await httpsCallable(functions, "saveItem")({ title: "from node script" });
  const snap = await getDoc(doc(getFirestore(app), "items/" + created.data.id));

  let offMachineCode = null;
  try {
    await httpsCallableFromURL(functions, "https://attacker.example/saveItem")({});
  } catch (err) {
    offMachineCode = err.code ?? null;
  }

  console.log(
    "NODE_OUTCOME " +
      JSON.stringify({
        uid: cred.user.uid,
        created: created.data,
        stored: snap.data() ?? null,
        offMachineCode,
      }),
  );
} finally {
  await deleteApp(app);
}
