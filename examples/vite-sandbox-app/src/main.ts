// Canonical firebase/* imports, the same in dev and prod.
// In `vite dev` the `@pyric/cli/vite` plugin swaps these to an in-process
// sandbox: no request reaches the project the config below names, and the
// sandbox reads its projectId the way Firebase does. `vite build` ships the
// real `firebase` package with the same config. Graduation is a build, not
// a code edit.
import { initializeApp, type FirebaseOptions } from 'firebase/app';
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

const apiKeyEnv = import.meta.env.VITE_FIREBASE_API_KEY;
let apiKey = 'demo';
const hasApiKey = apiKeyEnv !== undefined && apiKeyEnv !== null && apiKeyEnv !== '';
if (hasApiKey) {
  apiKey = apiKeyEnv as string;
}

const authDomainEnv = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
let authDomain = 'demo.firebaseapp.com';
const hasAuthDomain = authDomainEnv !== undefined && authDomainEnv !== null && authDomainEnv !== '';
if (hasAuthDomain) {
  authDomain = authDomainEnv as string;
}

const projectIdEnv = import.meta.env.VITE_FIREBASE_PROJECT_ID;
let projectId = 'demo';
const hasProjectId = projectIdEnv !== undefined && projectIdEnv !== null && projectIdEnv !== '';
if (hasProjectId) {
  projectId = projectIdEnv as string;
}

// Filled from .env (see .env.example) at `vite build` time and for production
// AI mode. In `vite dev` the pyric sandbox stands in for Firebase and reads
// the configured options.
const firebaseConfig: FirebaseOptions = {
  apiKey,
  authDomain,
  projectId,
};

const storageBucketEnv = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
const hasStorageBucket =
  storageBucketEnv !== undefined && storageBucketEnv !== null && storageBucketEnv !== '';
if (hasStorageBucket) {
  firebaseConfig.storageBucket = storageBucketEnv as string;
}

const messagingSenderIdEnv = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
const hasMessagingSenderId =
  messagingSenderIdEnv !== undefined &&
  messagingSenderIdEnv !== null &&
  messagingSenderIdEnv !== '';
if (hasMessagingSenderId) {
  firebaseConfig.messagingSenderId = messagingSenderIdEnv as string;
}

const appIdEnv = import.meta.env.VITE_FIREBASE_APP_ID;
const hasAppId = appIdEnv !== undefined && appIdEnv !== null && appIdEnv !== '';
if (hasAppId) {
  firebaseConfig.appId = appIdEnv as string;
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  status: $('auth-status'),
  avatar: $<HTMLImageElement>('avatar'),
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
    unsubscribePosts?.();
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
    // Provider sign-ins always carry a photoURL, in the sandbox as in
    // production; email/password and anonymous users have none.
    const hasPhoto = user.photoURL !== null;
    if (hasPhoto) {
      els.avatar.src = user.photoURL as string;
      els.avatar.hidden = false;
    } else {
      els.avatar.src = '';
      els.avatar.hidden = true;
    }
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
    els.avatar.hidden = true;
    els.avatar.src = '';
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
