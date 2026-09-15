import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, set, update, onValue, onDisconnect, goOffline, goOnline, increment } from 'firebase/database';

const config = { apiKey: 'demo', projectId: 'demo-hosted' };
const owner = initializeApp(config);
const observer = initializeApp(config, 'observer');
await signInAnonymously(getAuth(owner));
await signInAnonymously(getAuth(observer));
const ownerDb = getDatabase(owner);
const observerDb = getDatabase(observer);
const presence = ref(ownerDb, 'presence/owner');
const observerPresence = ref(observerDb, 'presence/owner');
const result = document.querySelector('#result');

function action(id, run) {
  document.querySelector(id).addEventListener('click', async () => {
    result.textContent = 'Working';
    try {
      await run();
      result.textContent = 'Done';
    } catch (error) {
      result.textContent = `${error.code ?? 'error'}: ${error.message}`;
    }
  });
}

onValue(ref(ownerDb, '.info/connected'), snapshot => {
  document.querySelector('#connected').textContent = String(snapshot.val());
});
onValue(ref(observerDb, '.info/connected'), snapshot => {
  document.querySelector('#observer-connected').textContent = String(snapshot.val());
});
onValue(observerPresence, snapshot => {
  document.querySelector('#presence').textContent = JSON.stringify(snapshot.val());
});
action('#arm', async () => {
  await set(presence, { state: 'online', untouched: 'initial', executions: 0 });
  await onDisconnect(presence).update({ state: 'offline', untouched: 'disconnected', executions: increment(1) });
});
action('#cancel-child', () => onDisconnect(ref(ownerDb, 'presence/owner/untouched')).cancel());
action('#cancel', () => onDisconnect(presence).cancel());
action('#offline', () => goOffline(ownerDb));
action('#online', () => goOnline(ownerDb));
action('#returned', () => update(observerPresence, { state: 'returned' }));
action('#delete', () => deleteApp(owner));
document.querySelector('#runtime').textContent = globalThis.__pyricRuntime.getSnapshot().mode;
result.textContent = 'Ready';
