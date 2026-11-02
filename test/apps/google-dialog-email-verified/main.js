// An app that gates on email_verified: a signed-in user may read their own
// allowlist entry only when the ID token says the email is verified.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
const auth = getAuth(app);

async function readAllowlist(email) {
  try {
    await getDoc(doc(getFirestore(app), "allowlist", email));
    return "allowed";
  } catch (error) {
    return error?.code ?? String(error);
  }
}

window.signIn = async () => {
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
  const { claims, signInProvider } = await user.getIdTokenResult();
  return {
    emailVerified: user.emailVerified,
    tokenEmailVerified: claims.email_verified ?? null,
    signInProvider,
    allowlistRead: await readAllowlist(user.email),
  };
};

window.signOutUser = () => signOut(auth);
