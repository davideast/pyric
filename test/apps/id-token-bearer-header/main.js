// A page that signs a user up, names them, and calls its own API with the ID
// token in an `Authorization: Bearer` header, as most apps with a server do.
// `signInHeld` keeps the user signed in, so `callApiAsCurrentUser` reads the
// cached token the way an app does on every request.
import { initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, signOut, updateProfile } from "firebase/auth";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-bearer" });
const auth = getAuth(app);

async function callApi(apiUrl, idToken) {
  try {
    const response = await fetch(`${apiUrl}/whoami`, { headers: { Authorization: `Bearer ${idToken}` } });
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { threw: String(error?.message ?? error) };
  }
}

window.runBearer = async (apiUrl, displayName, email) => {
  const { user } = await createUserWithEmailAndPassword(auth, email, "secret-pw");
  await updateProfile(user, { displayName });
  const idToken = await user.getIdToken(true);
  const answer = await callApi(apiUrl, idToken);
  await signOut(auth);
  return { uid: user.uid, answer };
};

window.signInHeld = async (displayName, email) => {
  const { user } = await createUserWithEmailAndPassword(auth, email, "secret-pw");
  await updateProfile(user, { displayName });
  return { uid: user.uid, idToken: await user.getIdToken(true) };
};

window.callApiAsCurrentUser = async (apiUrl) => {
  const idToken = await auth.currentUser.getIdToken();
  return { idToken, answer: await callApi(apiUrl, idToken) };
};
