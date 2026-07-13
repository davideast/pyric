// Minimal firebase/* app for the served-mode auth repro. Under `pyric dev`
// these imports are swapped to the pyric sandbox (worker-backed auth).
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';

const app = initializeApp({ apiKey: 'demo', projectId: 'demo' });
const auth = getAuth(app);

// The test observes these: every onAuthStateChanged fire is recorded.
window.__authLog = [];
const status = document.getElementById('status');

onAuthStateChanged(auth, (user) => {
  window.__authLog.push(user ? user.uid : null);
  status.textContent = user ? 'signed-in:' + user.uid : 'signed-out';
});

document
  .getElementById('signin')
  .addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()));
