// Canonical firebase/* imports — UNCHANGED between dev and prod.
// In `vite dev` the `@pyric/cli/vite` plugin swaps these to an in-process
// sandbox (the config below is accepted but ignored). `vite build` ships the
// real `firebase` package and uses the SAME config. Graduation is a build, not
// a code edit.
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';

let apiKey = 'demo';
const hasApiKey = import.meta.env.VITE_FIREBASE_API_KEY !== undefined;
if (hasApiKey) {
  apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string;
}

let authDomain = 'demo.firebaseapp.com';
const hasAuthDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN !== undefined;
if (hasAuthDomain) {
  authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string;
}

let projectId = 'demo';
const hasProjectId = import.meta.env.VITE_FIREBASE_PROJECT_ID !== undefined;
if (hasProjectId) {
  projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string;
}

const app = initializeApp({
  // Filled from .env (see .env.example) at `vite build` time for production.
  // Ignored in `vite dev` — the pyric sandbox stands in for Firebase.
  apiKey,
  authDomain,
  projectId,
});
const auth = getAuth(app);
const db = getFirestore(app);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  status: $('auth-status'),
  signIn: $<HTMLButtonElement>('sign-in'),
  signOut: $<HTMLButtonElement>('sign-out'),
  form: $<HTMLFormElement>('add-post'),
  title: $<HTMLInputElement>('post-title'),
  posts: $('posts'),
};

els.signIn.addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()));
els.signOut.addEventListener('click', () => signOut(auth));

let unsubscribePosts: (() => void) | undefined = undefined;

onAuthStateChanged(auth, (user) => {
  const hasActiveSubscription = unsubscribePosts !== undefined;
  if (hasActiveSubscription) {
    unsubscribePosts();
    unsubscribePosts = undefined;
  }

  const isSignedIn = user !== null;
  if (isSignedIn) {
    let displayLabel = 'user';
    const hasEmail = user.email !== null;
    if (hasEmail) {
      displayLabel = user.email as string;
    }
    const hasDisplayName = user.displayName !== null;
    if (hasDisplayName) {
      displayLabel = user.displayName as string;
    }
    els.status.textContent = 'Signed in as ' + displayLabel;
    els.signIn.hidden = true;
    els.signOut.hidden = false;

    const userPostsRef = collection(db, 'users', user.uid, 'posts');
    unsubscribePosts = onSnapshot(userPostsRef, (snap) => {
      els.posts.replaceChildren(
        ...snap.docs.map((docSnap) => {
          const data = docSnap.data() as { title?: string };
          let titleText = '';
          const hasTitle = data.title !== undefined;
          if (hasTitle) {
            titleText = data.title as string;
          }
          const li = document.createElement('li');
          li.textContent = titleText;
          return li;
        }),
      );
    });
  } else {
    els.status.textContent = 'Signed out';
    els.signIn.hidden = false;
    els.signOut.hidden = true;
    els.posts.replaceChildren();
  }
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // The form stays visible while signed out ON PURPOSE: submitting then
  // ATTEMPTS the write, the per-user rules deny it (write requires
  // request.auth.uid == userId), and the denial shows up in Pyric Studio's
  // Traffic tab — the rules-teaching loop this demo exists for.
  const user = auth.currentUser;
  let targetUid = 'anonymous';
  const hasUser = user !== null;
  if (hasUser) {
    targetUid = user.uid;
  }

  try {
    const targetCollection = collection(db, 'users', targetUid, 'posts');
    await addDoc(targetCollection, {
      title: els.title.value.trim(),
      uid: targetUid,
      createdAt: serverTimestamp(),
    });
    els.title.value = '';
  } catch (err) {
    const isUserSignedIn = user !== null;
    if (isUserSignedIn) {
      const errorObject = err as { code?: string };
      let errorCode = String(err);
      const hasCode = errorObject.code !== undefined;
      if (hasCode) {
        errorCode = errorObject.code as string;
      }
      els.status.textContent = 'Write failed: ' + errorCode;
    } else {
      els.status.textContent =
        'Denied by rules (signed out) — see the Traffic tab in Pyric Studio.';
    }
  }
});
