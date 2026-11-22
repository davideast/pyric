import * as adminApp from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const tag = process.argv[2] ?? 'default';
const swapped = adminApp.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target');
const registerActive = globalThis[Symbol.for('pyric.register.active')] === true;
let label = null;
if (swapped) {
  const existing = adminApp.getApps()[0];
  const app = existing ?? adminApp.initializeApp({ projectId: 'demo-user-preloads' });
  const ref = getFirestore(app).collection('items').doc(tag);
  await ref.set({ label: `written-${tag}` });
  const snap = await ref.get();
  label = snap.get('label') ?? null;
}
console.log(`MAIN_REPORT ${JSON.stringify({ tag, swapped, registerActive, label })}`);
