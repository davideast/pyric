import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, runTransaction, writeBatch } from 'firebase/firestore';
import { getDatabase, ref, set, get, update, increment, runTransaction as rtdbTransaction } from 'firebase/database';

const config = { apiKey: 'demo', projectId: 'demo-hosted' };
const first = initializeApp(config);
const second = initializeApp(config, 'second');
await signInAnonymously(getAuth(first));
await signInAnonymously(getAuth(second));
const firstStore = getFirestore(first);
const secondStore = getFirestore(second);
const firstDb = getDatabase(first);
const secondDb = getDatabase(second);
const output = document.querySelector('#result');

function action(id, run) {
  document.querySelector(id).addEventListener('click', async () => {
    output.textContent = 'Working';
    try {
      output.textContent = JSON.stringify(await run());
    } catch (error) {
      output.textContent = `${error.code ?? 'error'}: ${error.message}`;
    }
  });
}

action('#firestore', async () => {
  const target = doc(firstStore, 'counters/shared');
  await setDoc(target, { count: 0 });
  const read = Promise.withResolvers();
  const release = Promise.withResolvers();
  const seen = [];
  const pending = runTransaction(firstStore, async transaction => {
    const snapshot = await transaction.get(target);
    const count = snapshot.data().count;
    seen.push(count);
    read.resolve();
    await release.promise;
    transaction.set(target, { count: count + 1 });
  });
  try {
    await read.promise;
    await runTransaction(secondStore, async transaction => {
      const otherTarget = doc(secondStore, 'counters/shared');
      const snapshot = await transaction.get(otherTarget);
      transaction.set(otherTarget, { count: snapshot.data().count + 1 });
    });
  } finally {
    release.resolve();
  }
  await pending;
  const final = (await getDoc(doc(secondStore, 'counters/shared'))).data().count;
  return { firstReads: seen, final };
});
action('#rtdb', async () => {
  const target = ref(firstDb, 'counters/shared');
  await set(target, 0);
  const seen = [[], []];
  const results = await Promise.all([
    rtdbTransaction(target, current => { seen[0].push(current); return current + 1; }),
    rtdbTransaction(ref(secondDb, 'counters/shared'), current => { seen[1].push(current); return current + 1; }),
  ]);
  return { reads: seen, committed: results.map(result => result.committed), final: (await get(target)).val() };
});
action('#batch', async () => {
  await setDoc(doc(firstStore, 'atomic/allowed'), { value: 'before' });
  const batch = writeBatch(firstStore);
  batch.set(doc(firstStore, 'atomic/allowed'), { value: 'after' });
  batch.set(doc(firstStore, 'atomic/blocked'), { value: 'forbidden' });
  let error = 'Unexpected success';
  try { await batch.commit(); } catch (failure) { error = failure.code; }
  return {
    error,
    allowed: (await getDoc(doc(secondStore, 'atomic/allowed'))).data(),
    blockedExists: (await getDoc(doc(secondStore, 'atomic/blocked'))).exists(),
  };
});
action('#multipath', async () => {
  await set(ref(firstDb, 'atomic/allowed'), 'before');
  let error = 'Unexpected success';
  try { await update(ref(firstDb, 'atomic'), { allowed: 'after', blocked: 'forbidden' }); }
  catch (failure) { error = failure.code; }
  return { error, stored: (await get(ref(secondDb, 'atomic'))).val() };
});
action('#increment', async () => {
  await set(ref(firstDb, 'counters/uncertain'), increment(1));
  return 'Acknowledged';
});
action('#read', async () => ({ count: (await get(ref(secondDb, 'counters/uncertain'))).val() }));
await set(ref(firstDb, 'counters/uncertain'), 0);
document.querySelector('#runtime').textContent = globalThis.__pyricRuntime.getSnapshot().mode;
output.textContent = 'Ready';
