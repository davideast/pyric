// The checks the page and `node client.mjs` both run. firestore.rules lets a
// user write users/<uid> only when request.auth.token.sub is that uid and the
// token carries iss, aud, auth_time, iat and exp. Each check reports the
// write's outcome: "ok" or the error code.
import { initializeApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  reauthenticateWithCredential,
  signOut,
  EmailAuthProvider,
} from "firebase/auth";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const EMAIL = "ada@example.com";
const PASSWORD = "secret-pw";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
const auth = getAuth(app);
const db = getFirestore(app);

function write(path) {
  return setDoc(doc(db, path), { at: Date.now() }).then(() => "ok", (error) => error?.code ?? String(error));
}

/** Signs up, or signs in when an earlier run on this host created the account. */
async function signIn() {
  const credential = await createUserWithEmailAndPassword(auth, EMAIL, PASSWORD).catch((error) => {
    const exists = error?.code === "auth/email-already-in-use";
    if (!exists) throw error;
    return signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
  });
  return credential.user;
}

export async function runChecks() {
  const user = await signIn();
  const signedIn = await write(`users/${user.uid}`);
  const otherUser = await write("users/someone-else");
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(EMAIL, PASSWORD));
  const afterReauthentication = await write(`users/${user.uid}`);
  await signOut(auth);
  const signedOut = await write(`users/${user.uid}`);
  return { signedIn, otherUser, afterReauthentication, signedOut };
}
