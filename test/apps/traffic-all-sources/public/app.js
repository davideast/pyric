import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo', authDomain: 'demo-app.firebaseapp.com', projectId: 'demo-app' });
const db = getFirestore(app);

// The page's own traffic: one write and one read of its note.
window.writeFromPage = async () => {
  await setDoc(doc(db, 'notes', 'from-page'), { from: 'page' });
  return (await getDoc(doc(db, 'notes', 'from-page'))).data() ?? null;
};
document.getElementById('status').textContent = 'ready';
