// Canonical firebase/* imports — UNCHANGED between dev and prod.
// In `vite dev` the `pyric-tools/vite` plugin swaps these to an in-process
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

const app = initializeApp({
  // Filled from .env (see .env.example) at `vite build` time for production.
  // Ignored in `vite dev` — the pyric sandbox stands in for Firebase.
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo',
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

onAuthStateChanged(auth, (user) => {
  els.status.textContent = user
    ? 'Signed in as ' + (user.displayName ?? user.email)
    : 'Signed out';
  els.signIn.hidden = !!user;
  els.signOut.hidden = !user;
  els.form.hidden = !user;
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // The owner-based rules require uid == request.auth.uid on create.
  await addDoc(collection(db, 'posts'), {
    title: els.title.value.trim(),
    uid: auth.currentUser!.uid,
    createdAt: serverTimestamp(),
  });
  els.title.value = '';
});

onSnapshot(collection(db, 'posts'), (snap) => {
  els.posts.replaceChildren(
    ...snap.docs.map((d) => {
      const li = document.createElement('li');
      li.textContent = (d.data() as { title?: string }).title ?? '';
      return li;
    }),
  );
});
