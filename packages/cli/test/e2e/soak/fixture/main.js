// Minimal firebase/* app for the bridge soak suite. Under `pyric dev` these
// imports resolve to the pyric sandbox (SharedWorker-backed), so a write made
// here exercises the full browser→worker→bridge→Node delivery path.
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo', projectId: 'demo' });
const db = getFirestore(app);

// The rules require request.auth != null (the linter rejects allow-all), so
// the page session signs in anonymously before it drives any write.
const session = signInAnonymously(getAuth(app));

window.__soak = {
  // Studio-side / app-side edit driver for the change-fidelity scenario.
  setDoc: async (path, data) => {
    await session;
    return setDoc(doc(db, path), data);
  },
};

document.getElementById('status').textContent = 'ready';
