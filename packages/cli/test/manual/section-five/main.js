import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from 'firebase/firestore';
import { getDatabase, ref, set, get, onValue } from 'firebase/database';

const params = new URL(location.href).searchParams;
const service = params.get('service') ?? 'firestore';
const isFirestore = service === 'firestore';
const app = initializeApp({ apiKey: 'demo', projectId: 'rules-checkpoint' }, params.get('app') ?? 'red');
await signInAnonymously(getAuth(app));
const documentRef = doc(getFirestore(app), 'checks/value');
const databaseRef = ref(getDatabase(app), 'checks/value');
const result = document.querySelector('#result');
const listener = document.querySelector('#listener');
let deliveries = 0;
let stop = () => {};
function listen() {
  stop();
  const next = snapshot => {
    deliveries += 1;
    const data = isFirestore ? snapshot.data() : snapshot.val();
    listener.textContent = JSON.stringify(data ?? null);
    document.querySelector('#updates').textContent = String(deliveries);
  };
  const error = failure => { listener.textContent = failure.code; };
  stop = isFirestore ? onSnapshot(documentRef, next, error) : onValue(databaseRef, next, error);
}
async function run(operation) {
  result.textContent = 'Working';
  try {
    await operation();
    result.textContent = 'Succeeded';
  } catch (error) {
    result.textContent = error.code;
  }
}
document.querySelector('#write').onclick = () => run(() => {
  const value = { message: crypto.randomUUID() };
  return isFirestore ? setDoc(documentRef, value) : set(databaseRef, value);
});
document.querySelector('#read').onclick = () => run(() => isFirestore ? getDoc(documentRef) : get(databaseRef));
document.querySelector('#listen').onclick = listen;
listen();
document.querySelector('#uid').textContent = getAuth(app).currentUser.uid;
document.querySelector('#runtime').textContent = globalThis.__pyricRuntime.getSnapshot().mode;
document.querySelector('#service').textContent = service;
for (const button of document.querySelectorAll('button')) button.disabled = false;
result.textContent = 'Ready';
