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
  avatar: $<HTMLImageElement>('avatar'),
  signIn: $<HTMLButtonElement>('sign-in'),
  signOut: $<HTMLButtonElement>('sign-out'),
  form: $<HTMLFormElement>('add-post'),
  title: $<HTMLInputElement>('post-title'),
  posts: $('posts'),
};

els.signIn.addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()));
els.signOut.addEventListener('click', () => signOut(auth));

// A slow avatar source (see the `avatars` option in vite.config.ts, e.g. the
// Nano Banana generator) can take several seconds. pyric answers the first
// request with a placeholder immediately and marks it with the response header
// `x-pyric-avatar-origin: interim`, then serves the finished image once it is
// generated. This re-requests while the header reports `interim` and swaps the
// finished image into the same slot when it is ready. It is a no-op for the
// built-in default and pre-built sets, which are final on the first request,
// so it costs nothing unless a generator is actually running.
async function upgradeAvatarWhenReady(url: string, img: HTMLImageElement): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch {
      return;
    }
    if (response.headers.get('x-pyric-avatar-origin') !== 'interim') {
      // The final image is ready (or there is no generator). If the visible
      // placeholder was interim, force the <img> to fetch the finished bytes.
      const stillPlaceholder = img.src === url;
      if (stillPlaceholder) {
        img.src = url + (url.includes('?') ? '&' : '?') + 'ready=' + String(Date.now());
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

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
      const photoURL = user.photoURL as string;
      els.avatar.src = photoURL;
      els.avatar.hidden = false;
      void upgradeAvatarWhenReady(photoURL, els.avatar);
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
