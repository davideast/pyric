// The page from #1506: it imports pyric/auth next to the served firebase/auth
// to stage a sign-in result. It also imports pyric's other client subpaths, so
// a page that reaches for any of them shares the served entries' copy.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { getDatabase, ref } from "firebase/database";
import { getStorage, ref as storageRef } from "firebase/storage";
import { sandbox, getAuth as pyricGetAuth } from "pyric/auth";
import * as pyricFirestore from "pyric/firestore";
import * as pyricDatabase from "pyric/database";
import * as pyricStorage from "pyric/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  databaseURL: "https://demo-app-default-rtdb.firebaseio.com",
  storageBucket: "demo-app.appspot.com",
});

async function attempt(run) {
  try {
    return await run();
  } catch (error) {
    return `threw: ${error?.code ?? error?.message ?? error}`;
  }
}

window.runChecks = async () => {
  const checks = {};
  checks.getAuth = await attempt(() => (getAuth(app) ? "ok" : "no handle"));
  const auth = await attempt(() => getAuth(app));
  checks.oneAuthHandle = await attempt(() => pyricGetAuth(app) === auth);
  checks.staged = await attempt(() => {
    const user = { uid: "staged-user", email: "staged@example.com", displayName: null, isAnonymous: false };
    sandbox.mockSignInResult(auth, { user, providerId: "google.com", operationType: "signIn" });
    return "ok";
  });
  checks.signedIn = await attempt(async () => (await signInWithPopup(auth, new GoogleAuthProvider())).user.uid);
  checks.rulesSeeStagedUser = await attempt(async () => {
    const note = doc(getFirestore(app), "notes/staged-user");
    await setDoc(note, { body: "hello" });
    return (await getDoc(note)).data()?.body;
  });
  checks.getDatabase = await attempt(() => ref(getDatabase(app), "notes").key);
  checks.getStorage = await attempt(() => storageRef(getStorage(app), "notes/a.txt").fullPath);
  checks.subpathsLoaded = [pyricFirestore, pyricDatabase, pyricStorage].every((namespace) => Object.keys(namespace).length > 0);
  return checks;
};
