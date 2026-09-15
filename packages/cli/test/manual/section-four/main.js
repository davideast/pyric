import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, setDoc } from 'firebase/firestore';

const hasApp = getApps().length > 0;
const app = hasApp ? getApp() : initializeApp({ apiKey: 'demo', projectId: 'demo-packed' });
const auth = getAuth(app);
const isSignedOut = auth.currentUser === null;
if (isSignedOut) await signInAnonymously(auth);
const target = doc(getFirestore(app), 'shared/greeting');
const button = document.querySelector('#write');
const result = document.querySelector('#result');
let updates = 0;
const stop = onSnapshot(target, snapshot => {
  updates += 1;
  document.querySelector('#updates').textContent = String(updates);
  document.querySelector('#document').textContent = JSON.stringify(snapshot.data() ?? null);
}, error => { result.textContent = error.code; });
const write = async () => {
  result.textContent = 'Writing';
  try {
    await setDoc(target, { message: `Write ${crypto.randomUUID()}`, uid: auth.currentUser.uid });
    result.textContent = 'Written';
  } catch (error) {
    result.textContent = `${error.code}: ${error.message}`;
  }
};
button.addEventListener('click', write);
button.disabled = false;
document.querySelector('#uid').textContent = auth.currentUser.uid;
document.querySelector('#runtime').textContent = globalThis.__pyricRuntime.getSnapshot().mode;
document.querySelector('#version').textContent = 'version-one';
result.textContent = 'Ready';
const supportsHmr = import.meta.hot !== undefined;
if (supportsHmr) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    stop();
    button.removeEventListener('click', write);
  });
}
