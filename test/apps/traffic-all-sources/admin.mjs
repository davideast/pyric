// `node --import @pyric/cli/register admin.mjs` writes notes/from-admin on
// the Node host with firebase-admin, as server code does.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = initializeApp({ projectId: 'demo-app' });
await getFirestore(app).doc('notes/from-admin').set({ from: 'admin' });
console.log('admin done');
process.exit(0);
