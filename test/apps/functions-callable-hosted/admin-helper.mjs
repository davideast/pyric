// Mints a custom token via firebase-admin, signs in on the Node host via
// firebase/auth to obtain a real sandbox ID token, or reads items/<id> back.
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp as initClient } from 'firebase/app';
import { getAuth as getClientAuth, signInWithCustomToken } from 'firebase/auth';

const mode = process.argv[2];
const adminApp = initAdmin({ projectId: 'demo-functions-callable' });

if (mode === 'mint-id-token') {
  const uid = process.argv[3] ?? 'user-1';
  const customToken = await getAdminAuth(adminApp).createCustomToken(uid);
  const clientApp = initClient({ apiKey: 'demo', projectId: 'demo-functions-callable' });
  const cred = await signInWithCustomToken(getClientAuth(clientApp), customToken);
  const idToken = await cred.user.getIdToken();
  console.log(`ID_TOKEN ${idToken}`);
} else if (mode === 'read-items') {
  for (const id of process.argv.slice(3)) {
    const snap = await getFirestore(adminApp).doc(`items/${id}`).get();
    console.log(`${id}: ${JSON.stringify(snap.data() ?? null)}`);
  }
}
process.exit(0);
