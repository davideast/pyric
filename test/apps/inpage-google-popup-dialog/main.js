import { initializeApp } from "firebase/app";
import {
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  linkWithPopup,
  signInAnonymously,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { sandbox as authSandbox } from "pyric/auth";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
});
const auth = getAuth(app);

window.signInGooglePopup = async () => {
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
  const token = await user.getIdTokenResult();
  return {
    uid: user.uid,
    currentUid: auth.currentUser ? auth.currentUser.uid : null,
    sameUserRef: user === auth.currentUser,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    photoURL: user.photoURL,
    signInProvider: token.signInProvider,
  };
};

window.signInStagedMockPopup = async () => {
  const now = new Date().toISOString();
  authSandbox.mockSignInResult(auth, {
    user: {
      uid: "staged-popup-user",
      email: "staged@example.com",
      displayName: "Staged",
      photoURL: null,
      isAnonymous: false,
      emailVerified: false,
      getIdToken: async () => "staged-token",
      getIdTokenResult: async () => ({
        token: "staged-token",
        claims: {},
        expirationTime: now,
        issuedAtTime: now,
        authTime: now,
      }),
    },
    providerId: "google.com",
    operationType: "signIn",
  });
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
  };
};

window.startAnonymousForLink = async () => {
  const { user } = await signInAnonymously(auth);
  return user.uid;
};

window.linkGithubPopup = async () => {
  if (!auth.currentUser) {
    throw new Error("expected signed-in anonymous user before linkWithPopup");
  }
  const { user } = await linkWithPopup(auth.currentUser, new GithubAuthProvider());
  return {
    uid: user.uid,
    providers: user.providerData.map((entry) => entry.providerId),
  };
};

window.signOutUser = () => signOut(auth);
