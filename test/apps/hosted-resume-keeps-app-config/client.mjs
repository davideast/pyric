import { initializeApp } from 'firebase/app';
import { get, getDatabase, ref, set } from 'firebase/database';

const app = initializeApp({
  projectId: 'legacy-resume-project',
  databaseURL: 'https://legacy-resume-project.firebaseio.com',
});
const db = getDatabase(app);
await set(ref(db, 'open/greeting'), 'configured-after-resume');
const snap = await get(ref(db, 'open/greeting'));
console.log(`RESULT:${JSON.stringify(snap.val())}`);
process.exit(0);
