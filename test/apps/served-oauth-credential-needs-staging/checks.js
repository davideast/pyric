// The checks the page and `node client.mjs` both run. An account with a
// password owns private/<uid>; a second account, staged@example.com, owns
// staged/<uid> and is the user a staged result signs in as. Each check presents
// one federated credential to signInWithCredential, then reports who is signed
// in, whether the owner's document reads, and signs out.
import { initializeApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCredential,
  signOut,
  GoogleAuthProvider,
  OAuthProvider,
} from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { sandbox } from "pyric/auth";

const OWNER = "owner@example.com";
const STAGED = "staged@example.com";
const PASSWORD = "right-password";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
const auth = getAuth(app);
const db = getFirestore(app);

/** Creates an account, or signs in as it when an earlier run on this host created it, and writes its document. */
async function createAccount(email, collection) {
  const credential = await createUserWithEmailAndPassword(auth, email, PASSWORD).catch((error) => {
    const exists = error?.code === "auth/email-already-in-use";
    if (!exists) throw error;
    return signInWithEmailAndPassword(auth, email, PASSWORD);
  });
  const user = credential.user;
  await setDoc(doc(db, collection, user.uid), { email });
  await signOut(auth);
  return user;
}

function readDoc(collection, uid) {
  return getDoc(doc(db, collection, uid)).then(() => "allowed", (error) => error?.code ?? String(error));
}

function whoIsSignedIn(accounts) {
  const uid = auth.currentUser?.uid ?? null;
  if (uid === null) return null;
  if (uid === accounts.owner.uid) return "owner";
  if (uid === accounts.staged.uid) return "staged";
  return "someone else";
}

function stage(user, providerId) {
  sandbox.mockSignInResult(auth, { user, providerId, operationType: "signIn" });
}

/** Presents one credential and reports the outcome, who is signed in after, and the document reads. */
async function present(credential, accounts) {
  let outcome;
  try {
    const result = await signInWithCredential(auth, credential);
    const providers = result.user.providerData.map((entry) => entry.providerId).sort();
    outcome = { ok: true, providerId: result.providerId, providers };
  } catch (error) {
    outcome = { ok: false, code: error?.code ?? String(error) };
  }
  const signedIn = whoIsSignedIn(accounts);
  const read = await readDoc("private", accounts.owner.uid);
  const stagedRead = await readDoc("staged", accounts.staged.uid);
  await signOut(auth);
  return { ...outcome, signedIn, read, stagedRead };
}

async function ownerProviders() {
  const { user } = await signInWithEmailAndPassword(auth, OWNER, PASSWORD);
  const providers = user.providerData.map((entry) => entry.providerId).sort();
  await signOut(auth);
  return providers;
}

export async function runChecks() {
  const accounts = {
    owner: await createAccount(OWNER, "private"),
    staged: await createAccount(STAGED, "staged"),
  };
  const checks = {};
  checks.googleTokenUnstaged = await present(GoogleAuthProvider.credential("made-up-token"), accounts);
  checks.ownerEmailUnstaged = await present({ providerId: "google.com", email: OWNER }, accounts);
  checks.ownerEmailWrongPassword = await present(
    { providerId: "google.com", signInMethod: "password", email: OWNER, password: "wrong-password" },
    accounts,
  );
  checks.oidcUnstaged = await present(new OAuthProvider("oidc.acme").credential({ idToken: "made-up" }), accounts);
  stage(accounts.staged, "google.com");
  checks.googleStaged = await present(GoogleAuthProvider.credential("any-token"), accounts);
  checks.googleUsedUp = await present(GoogleAuthProvider.credential("any-token"), accounts);
  stage(accounts.staged, "github.com");
  checks.otherProviderStaged = await present(GoogleAuthProvider.credential("any-token"), accounts);
  checks.ownerProviders = await ownerProviders();
  return checks;
}
