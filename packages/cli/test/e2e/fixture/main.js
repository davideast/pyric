// Minimal firebase/* app for the served-mode auth repro. Under `pyric dev`
// these imports are swapped to the pyric sandbox (worker-backed auth).
import { deleteApp, initializeApp } from 'firebase/app';
import { doc, getFirestore, onSnapshot } from 'firebase/firestore';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';

const app = initializeApp({ apiKey: 'demo', projectId: 'demo' });
const auth = getAuth(app);
const namedApp = initializeApp(
  { apiKey: 'demo', projectId: 'demo' },
  'fanout-observer',
);
const namedAuth = getAuth(namedApp);

window.__namedAuthLog = [];
onAuthStateChanged(namedAuth, (user) => {
  window.__namedAuthLog.push(user ? user.uid : null);
});

window.__registerThenDeleteNamedAuth = async () => {
  const namedApp = initializeApp(
    { apiKey: 'demo', projectId: 'demo' },
    'deleted-before-switch',
  );
  getAuth(namedApp);
  await deleteApp(namedApp);
};

// The test observes these: every onAuthStateChanged fire is recorded.
window.__authLog = [];
window.__authError = null;
// The default-avatar tests read the current user's photoURL (Firebase
// exposes it only on the User object, never in a DOM attribute) and bind an
// <img> to it so the test can assert the pixels actually render.
window.__photoURL = null;
const status = document.getElementById('status');
const avatar = document.getElementById('avatar');

onAuthStateChanged(auth, (user) => {
  window.__authLog.push(user ? user.uid : null);
  window.__photoURL = user ? user.photoURL : null;
  status.textContent = user ? 'signed-in:' + user.uid : 'signed-out';
  if (avatar) avatar.src = user && user.photoURL ? user.photoURL : '';
});

document
  .getElementById('signin')
  .addEventListener('click', () => {
    void signInWithPopup(auth, new GoogleAuthProvider()).catch((error) => {
      window.__authError = { code: error?.code, message: error?.message };
    });
  });

// A page-side Firestore listener with an explicit owner. On a served page the
// sandbox runs in a SharedWorker, so this call is what proves the owner the
// caller passed reaches the worker's attach event instead of stopping at the
// port.
const db = getFirestore(app);
window.__noteFires = 0;
document.getElementById('listen').addEventListener('click', async () => {
  // The fixture's rules allow reads to signed-in callers only.
  if (!auth.currentUser) await signInAnonymously(auth);
  onSnapshot(
    doc(db, 'notes/astro-host'),
    { owner: 'notes-panel' },
    (snap) => {
      window.__noteFires += 1;
      const panel = document.getElementById('notes-panel');
      if (panel) panel.textContent = JSON.stringify(snap.data() ?? null);
    },
  );
});
