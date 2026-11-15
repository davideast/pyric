import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, get } from 'firebase/database';

const out = document.getElementById('out');
try {
  const app = initializeApp({
    projectId: 'demo-items',
    databaseURL: 'https://demo-items-default-rtdb.firebaseio.com',
  });
  const db = getDatabase(app);
  await set(ref(db, 'items/a'), { value: 1 });
  const snap = await get(ref(db, 'items/a'));
  out.textContent = 'wrote ' + JSON.stringify(snap.val());
} catch (error) {
  let detail = String(error);
  if (error instanceof Error) detail = error.message;
  out.textContent = `error ${detail}`;
}
window.pageDone = true;
