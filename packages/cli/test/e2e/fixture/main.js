// Minimal firebase/* app for the served-mode auth repro. Under `pyric dev`
// these imports are swapped to the pyric sandbox (worker-backed auth).
import { deleteApp, initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
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
const status = document.getElementById('status');

onAuthStateChanged(auth, (user) => {
  window.__authLog.push(user ? user.uid : null);
  status.textContent = user ? 'signed-in:' + user.uid : 'signed-out';
});

document
  .getElementById('signin')
  .addEventListener('click', () => {
    void signInWithPopup(auth, new GoogleAuthProvider()).catch((error) => {
      window.__authError = { code: error?.code, message: error?.message };
    });
  });
