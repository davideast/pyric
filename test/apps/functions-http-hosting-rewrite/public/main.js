// The page calls its backend same-origin through the Hosting rewrite, then
// reads what the function wrote with the client SDK.
import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore } from 'firebase/firestore';

const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-functions-http' }));

window.addMessage = async (text) => {
  document.cookie = '__session=page-session; path=/';
  document.cookie = 'tracking=dropped; path=/';
  const response = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json();
  const snapshot = await getDoc(doc(db, 'messages', body.id));
  return { status: response.status, path: body.path, stored: snapshot.data() ?? null };
};
