import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

const app = initializeApp({
  projectId: 'demo-guards',
  storageBucket: 'demo-guards.appspot.com',
});
const bucket = getStorage(app).bucket();
const file = bucket.file('items/record-1.txt');
await file.save(Buffer.from('record-data'), {
  resumable: false,
  metadata: {
    contentType: 'text/plain',
    metadata: { firebaseStorageDownloadTokens: 'tok-valid-1' },
  },
});

console.log(JSON.stringify({ bucket: bucket.name, path: file.name }));
process.exit(0);
