import { getApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import * as firestore from 'firebase/firestore';
const { connectFirestoreEmulator, doc, getDoc, getFirestore } = firestore;

const result = document.querySelector('#result');
try {
  const backend = await fetch('/test-backend.json').then((response) => response.json());
  const app = initializeApp({ projectId: backend.projectId, apiKey: 'fake-api-key' });
  const auth = getAuth(app);
  connectAuthEmulator(auth, backend.authUrl, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', backend.firestorePort);
  const credential = await signInWithEmailAndPassword(auth, backend.email, backend.password);
  const snapshot = await getDoc(doc(db, 'proofs', 'identity'));
  const ownsServices = getApp() === app && auth.app === app && db.app === app;
  const ownsUser = auth.currentUser === credential.user && snapshot.data()?.ownerId === credential.user.uid;
  const isOriginalSnapshot = snapshot instanceof firestore.DocumentSnapshot && snapshot.ref.firestore === db;
  const hasRealOwnership = ownsServices && ownsUser && isOriginalSnapshot;
  if (hasRealOwnership) result.textContent = snapshot.data()?.message;
  else result.textContent = 'Wrong SDK, App, Auth, or snapshot ownership';
} catch (error) {
  result.textContent = `Failed: ${error.message}`;
}
