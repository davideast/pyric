// A sign-up page that uses only Firebase Auth, as a login screen often does
// before an app adds a database. A user who signs up and reloads expects to
// still be signed in, and to sign in again later with the same password.
import { initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";

const auth = getAuth(initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-auth-only" }));

/** The first auth state after the page loads: the restored session's uid, or null. */
function restoredUid() {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user?.uid ?? null);
    });
  });
}

window.account = {
  restored: restoredUid,
  async signUp(email, password) {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    return user.uid;
  },
  async signOutAndBackIn(email, password) {
    await signOut(auth);
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    return user.uid;
  },
};
