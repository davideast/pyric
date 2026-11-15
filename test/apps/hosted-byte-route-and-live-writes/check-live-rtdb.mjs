import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const app = initializeApp({
  projectId: 'demo-guards',
  databaseURL: 'https://demo-guards-default-rtdb.firebaseio.com',
});

try {
  const db = getDatabase(app);
  const setSnap = await db.ref('items/dc-set').get();
  const updateSnap = await db.ref('items/dc-update').get();
  console.log(JSON.stringify({
    dcSetExists: setSnap.exists(),
    dcUpdateExists: updateSnap.exists(),
  }));
} finally {
  await deleteApp(app);
}
process.exit(0);
