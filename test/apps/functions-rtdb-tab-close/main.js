import { initializeApp } from 'firebase/app';
import { get, getDatabase, ref, set, update } from 'firebase/database';

const app = initializeApp({
  apiKey: 'demo',
  projectId: 'demo-functions-rtdb',
  databaseURL: 'https://demo-functions-rtdb-default-rtdb.firebaseio.com',
});
const db = getDatabase(app);

window.writeBatch = async (count) => {
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    entries[`item-${String(i).padStart(2, '0')}/original`] = `value-${i}`;
  }
  await update(ref(db, 'items'), entries);
};

window.writeSingle = async (id, text) => {
  await set(ref(db, `items/${id}/original`), text);
};

window.readUppercase = async (id) => {
  const snap = await get(ref(db, `items/${id}/uppercase`));
  return snap.exists() ? snap.val() : null;
};
