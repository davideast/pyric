// Writes one post with firebase-admin, as a server route of the app would.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [title] = process.argv.slice(2);
const db = getFirestore(initializeApp({ projectId: 'demo-nextjs-app' }));
await db.collection('posts').doc('seeded').set({ title, uid: 'seed-script' });
console.log('seeded');
process.exit(0);
