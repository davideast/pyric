// The sign-in checks the page and `node client.mjs` both run. An account with
// a password owns private/<uid>; each check presents one credential to
// signInWithCredential, then reads that document and signs out. The email
// credentials come from EmailAuthProvider; the look-alikes are hand-built with
// a provider id that is not exactly `password` and not federated (#1466).
import { initializeApp } from "firebase/app";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCredential,
  signOut,
  EmailAuthProvider,
} from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";

const OWNER = "owner@example.com";
const PASSWORD = "right-password";
const MADE_UP_LINK = "https://demo-app.firebaseapp.com/__/auth/action?mode=signIn&oobCode=made-up&apiKey=demo";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
const auth = getAuth(app);
const db = getFirestore(app);

/** Creates the owner, or signs in as it when an earlier run on this host created it, and writes its document. */
async function createOwner() {
  const credential = await createUserWithEmailAndPassword(auth, OWNER, PASSWORD).catch((error) => {
    const exists = error?.code === "auth/email-already-in-use";
    if (!exists) throw error;
    return signInWithEmailAndPassword(auth, OWNER, PASSWORD);
  });
  const uid = credential.user.uid;
  await setDoc(doc(db, "private", uid), { owner: OWNER });
  await signOut(auth);
  return uid;
}

function whoIsSignedIn(ownerUid) {
  const uid = auth.currentUser?.uid ?? null;
  if (uid === null) return null;
  if (uid === ownerUid) return "owner";
  return "someone else";
}

/** Presents one credential and reports the outcome, who is signed in after, and the owner's document read. */
async function present(credential, ownerUid) {
  let outcome;
  try {
    const result = await signInWithCredential(auth, credential);
    outcome = { ok: true, providerId: result.providerId };
  } catch (error) {
    outcome = { ok: false, code: error?.code ?? String(error) };
  }
  const signedIn = whoIsSignedIn(ownerUid);
  const read = await getDoc(doc(db, "private", ownerUid)).then(() => "allowed", (error) => error?.code ?? String(error));
  await signOut(auth);
  return { ...outcome, signedIn, read };
}

/** The provider ids on the owner's account, read after signing in with the right password. */
async function ownerProviderIds() {
  const credential = await signInWithEmailAndPassword(auth, OWNER, PASSWORD);
  const providerIds = credential.user.providerData.map((entry) => entry.providerId);
  await signOut(auth);
  return providerIds;
}

/** Hand-built credentials whose provider id looks like an email or other built-in one but is not federated. */
function lookAlikes(ownerUid) {
  return {
    capitalPassword: { providerId: "Password", signInMethod: "password", email: OWNER, password: "wrong-password" },
    trailingSpacePassword: { providerId: "password ", signInMethod: "password", email: OWNER, password: "wrong-password" },
    emailLinkProvider: { providerId: "emailLink", email: OWNER },
    phoneWithOwnerUid: { providerId: "phone", uid: ownerUid },
    madeUpProvider: { providerId: "acme", email: OWNER },
  };
}

export async function runChecks() {
  const ownerUid = await createOwner();
  const checks = {
    wrongPassword: await present(EmailAuthProvider.credential(OWNER, "wrong-password"), ownerUid),
    emptyPassword: await present(EmailAuthProvider.credential(OWNER, ""), ownerUid),
    unknownEmail: await present(EmailAuthProvider.credential("nobody@example.com", PASSWORD), ownerUid),
    madeUpLink: await present(EmailAuthProvider.credentialWithLink(OWNER, MADE_UP_LINK), ownerUid),
  };
  for (const [name, credential] of Object.entries(lookAlikes(ownerUid))) {
    checks[name] = await present(credential, ownerUid);
  }
  checks.rightPassword = await present(EmailAuthProvider.credential(OWNER, PASSWORD), ownerUid);
  return { checks, ownerProviderIds: await ownerProviderIds() };
}
