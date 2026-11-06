// A module service worker under live mode's Vite plugin. It imports
// `firebase/*` as an app's worker does, so it gets the live rows and the
// observer module they share. On the page's request it makes one Firestore
// read that production cannot answer from an empty cache, which the rows
// send as one observed call. The page hears the call's code.
import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore } from 'firebase/firestore';

const app = initializeApp({ projectId: 'live-service-worker', apiKey: 'live-service-worker-key', appId: '1:1:web:1' });
const db = getFirestore(app);
// A closed loopback port, so nothing reaches a Firebase backend.
connectFirestoreEmulator(db, '127.0.0.1', 9);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'read-from-cache') return;
  const reply = getDocFromCache(doc(db, 'rooms/worker'))
    .then(() => 'found', (error) => error.code)
    .then((code) => event.ports[0]?.postMessage(code));
  event.waitUntil(reply);
});
