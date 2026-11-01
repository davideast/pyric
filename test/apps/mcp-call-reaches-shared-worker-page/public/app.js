import { initializeApp } from 'firebase/app';
import { getFirestore, doc, onSnapshot } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo', authDomain: 'demo-app.firebaseapp.com', projectId: 'demo-app' });
const db = getFirestore(app);

// The page listens to the note an agent writes through `pyric mcp`.
window.note = { listening: false, data: null, error: null };
onSnapshot(
  doc(db, 'notes', 'from-agent'),
  (snap) => {
    window.note.listening = true;
    window.note.data = snap.exists() ? snap.data() : null;
    document.getElementById('note').textContent = JSON.stringify(window.note.data);
  },
  (error) => {
    window.note.error = String(error);
  },
);
