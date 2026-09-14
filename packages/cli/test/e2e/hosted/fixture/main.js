import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
await signInAnonymously(getAuth(app));
const sharedDocument = doc(getFirestore(app), 'shared', 'greeting');
const observed = document.querySelector('#document');
const writeResult = document.querySelector('#write-result');
const writeButton = document.querySelector('#write');

onSnapshot(sharedDocument, (snapshot) => {
  observed.textContent = snapshot.data()?.message ?? 'Empty';
}, (error) => {
  observed.textContent = `Listener failed: ${error.message}`;
});

writeButton.disabled = false;
writeButton.addEventListener('click', async () => {
  try {
    await setDoc(sharedDocument, { message: 'Hello from the other browser' });
    writeResult.textContent = 'Written';
  } catch (error) {
    writeResult.textContent = `Write failed: ${error.message}`;
  }
});
