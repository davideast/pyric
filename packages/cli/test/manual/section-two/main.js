import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
const auth = getAuth(app);
const db = getFirestore(app);
const identity = document.querySelector('#identity');
const result = document.querySelector('#result');
const tenant = document.querySelector('#tenant');
let stopListening;
let updates = 0;

async function showIdentity(forceRefresh = false) {
  const user = auth.currentUser;
  const token = await user?.getIdTokenResult(forceRefresh);
  identity.textContent = JSON.stringify({
    configuredTenant: auth.tenantId,
    uid: user?.uid ?? null,
    userTenant: user?.tenantId ?? null,
    tokenTenant: token?.claims.firebase?.tenant ?? null,
    role: token?.claims.role ?? null,
  }, null, 2);
  document.querySelector('#runtime').textContent = globalThis.__pyricRuntime?.getSnapshot().mode ?? 'Unknown';
}

function action(id, run) {
  document.querySelector(id).addEventListener('click', async () => {
    result.textContent = 'Working';
    try {
      await run();
      await showIdentity();
    } catch (error) {
      result.textContent = `${error.code ?? 'error'}: ${error.message}`;
    }
  });
}

for (const name of ['blue', 'red']) {
  action(`#${name}`, async () => {
    stopListening?.();
    auth.tenantId = name;
    tenant.value = name;
    await signInWithEmailAndPassword(auth, `${name}@example.test`, 'password');
    result.textContent = `Signed in ${name}`;
  });
  action(`#write-${name}`, async () => {
    const message = `${name} write ${Date.now()}`;
    await setDoc(doc(db, 'tenants', name, 'profiles', `${name}-user`), { message });
    result.textContent = `Written: ${message}`;
  });
}

action('#signout', async () => {
  await signOut(auth);
  result.textContent = 'Signed out';
});
action('#refresh', async () => {
  await showIdentity(true);
  result.textContent = 'Token refreshed';
});
action('#listen', async () => {
  const user = auth.currentUser;
  const isSignedOut = user === null;
  if (isSignedOut) throw new Error('Sign in first');
  stopListening?.();
  updates = 0;
  document.querySelector('#updates').textContent = '0';
  stopListening = onSnapshot(doc(db, 'tenants', user.tenantId, 'profiles', user.uid), snapshot => {
    updates += 1;
    document.querySelector('#updates').textContent = String(updates);
    document.querySelector('#document').textContent = JSON.stringify(snapshot.data() ?? 'Missing', null, 2);
    void showIdentity();
  }, error => {
    document.querySelector('#document').textContent = `${error.code}: ${error.message}`;
  });
  result.textContent = 'Listening';
});
tenant.addEventListener('change', async () => {
  auth.tenantId = tenant.value;
  await showIdentity();
  result.textContent = 'Next sign-in tenant changed';
});
onAuthStateChanged(auth, () => { void showIdentity(); });
await showIdentity();
