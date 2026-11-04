// `node --import @pyric/cli/register client.mjs` reads notes/from-client-read
// with the client Firebase SDK from a server process, as a script or a
// server-rendered route does, then deletes its app and exits.
import { initializeApp, deleteApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo', appId: 'demo', projectId: 'demo-app' });
const snapshot = await getDoc(doc(getFirestore(app), 'notes/from-client-read'));
console.log(`client read ${JSON.stringify(snapshot.exists() ? snapshot.data() : null)}`);
await deleteApp(app);
console.log('client done');
