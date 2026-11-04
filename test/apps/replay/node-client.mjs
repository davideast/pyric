// Plain Node app code for grpc.test.ts: the Node build of the Firestore SDK,
// from this checkout's node_modules, signs in, reads, listens and writes over
// gRPC. The SDK's own emulator connectors point it at the replay server, the
// way an app's config would.
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, doc, getCountFromServer, getDoc, getFirestore, onSnapshot, query, setDoc, setLogLevel, where,
} from 'firebase/firestore';

const [authOrigin, firestoreHost] = process.argv.slice(2);
const [host, port] = firestoreHost.split(':');
const app = initializeApp({ projectId: 'demo-replay', apiKey: 'test-api-key', appId: '1:1:web:replay' });
const auth = getAuth(app);
connectAuthEmulator(auth, authOrigin, { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, host, Number(port));

if (process.env.REPLAY_DEBUG) setLogLevel('debug');
const result = {};
const user = await signInWithEmailAndPassword(auth, 'reader@example.com', 'test-password');
result.uid = user.user.uid;
const lobby = await getDoc(doc(db, 'rooms/lobby'));
result.read = { exists: lobby.exists(), data: lobby.data(), fromCache: lobby.metadata.fromCache };
result.denied = await getDoc(doc(db, 'rooms/secret')).then(() => 'read', (error) => error.code);
const seen = [];
let stop = () => {};
const updated = new Promise((resolve, reject) => {
  stop = onSnapshot(query(collection(db, 'rooms'), where('open', '==', true)), (snapshot) => {
    const rooms = snapshot.docs.map((room) => room.id);
    seen.push(rooms);
    if (rooms.includes('garden')) resolve();
  }, reject);
});
await new Promise((resolve) => setTimeout(resolve, 200));
await setDoc(doc(db, 'rooms/garden'), { name: 'Garden', open: true });
await updated;
stop();
result.listened = seen;
result.deniedWrite = await setDoc(doc(db, 'rooms/secret'), { name: 'Secret' }).then(() => 'written', (error) => error.code);
// No recording holds a count, so the server refuses it and lists it as unmatched.
result.counted = await getCountFromServer(collection(db, 'rooms')).then(() => 'counted', (error) => error.code);
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
