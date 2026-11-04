// A page that signs a user up, names them, and calls its own API with the ID
// token in an `Authorization: Bearer` header, as most apps with a server do.
// `signInHeld` keeps the user signed in, so `callApiAsCurrentUser` reads the
// cached token the way an app does on every request. `exchangeCustomToken`
// fetches a custom token from the API, exchanges it with
// signInWithCustomToken, and sends the ID token it gets back to the API's
// /claims, or answers the code the exchange failed with.
import { initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInWithCustomToken, signOut, updateProfile } from "firebase/auth";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-bearer" });
const auth = getAuth(app);

// Every auth state the page's listener saw, as uids (null when signed out).
const authStates = [];
onAuthStateChanged(auth, (user) => authStates.push(user?.uid ?? null));

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

async function callClaims(apiUrl, idToken) {
  const response = await fetch(`${apiUrl}/claims`, { headers: { Authorization: `Bearer ${idToken}` } });
  return { status: response.status, body: await response.json() };
}

window.exchangeCustomToken = async (apiUrl, uid, project) => {
  const query = new URLSearchParams({ uid, project: project ?? "" });
  const { token } = await (await fetch(`${apiUrl}/custom-token?${query}`)).json();
  try {
    const { user } = await signInWithCustomToken(auth, token);
    const answer = await callClaims(apiUrl, await user.getIdToken());
    await signOut(auth);
    return { token, uid: user.uid, answer };
  } catch (error) {
    return { token, code: error?.code ?? String(error) };
  }
};

window.exchangeGivenToken = async (token) => {
  try {
    await signInWithCustomToken(auth, token);
    await signOut(auth);
    return { code: null };
  } catch (error) {
    return { code: error?.code ?? String(error) };
  }
};

window.callApiAsCurrentUser = async (apiUrl) => {
  const idToken = await auth.currentUser.getIdToken();
  return { idToken, answer: await callApi(apiUrl, idToken) };
};

// Force a token refresh for the signed-in user, as an app does after it learns
// the account changed, and report the error code and the sign-in state after.
window.forceRefresh = async () => {
  let code = null;
  try {
    await auth.currentUser.getIdToken(true);
  } catch (error) {
    code = error?.code ?? String(error);
  }
  return { code, currentUid: auth.currentUser?.uid ?? null, lastAuthState: authStates.at(-1) ?? null };
};
