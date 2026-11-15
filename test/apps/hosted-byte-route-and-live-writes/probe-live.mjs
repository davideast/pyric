import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getStorage } from 'firebase-admin/storage';

const app = initializeApp({
  projectId: 'demo-guards',
  storageBucket: 'demo-guards.appspot.com',
  databaseURL: 'https://demo-guards-default-rtdb.firebaseio.com',
});

const report = {
  resumableCode: 'ok',
  resumableUploadBypassed: false,
  disconnectSetCode: 'ok',
  disconnectUpdateCode: 'ok',
  disconnectRemoveCode: 'ok',
};

try {
  const bucket = getStorage(app).bucket('demo-guards.appspot.com');
  const db = getDatabase(app);

  try {
    const [uploadUrl] = await bucket.file('items/session-write.txt').createResumableUpload({
      metadata: { contentType: 'text/plain' },
    });
    const payload = Buffer.from('unexpected-upload');
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-length': String(payload.length), 'content-type': 'text/plain' },
      body: payload,
    });
    if (putRes.ok) report.resumableUploadBypassed = true;
  } catch (error) {
    report.resumableCode = typeof error?.code === 'string' ? error.code : String(error);
  }

  try {
    await db.ref('items/dc-set').onDisconnect().set({ written: true });
  } catch (error) {
    report.disconnectSetCode = typeof error?.code === 'string' ? error.code : String(error);
  }

  try {
    await db.ref('items/dc-update').onDisconnect().update({ written: true });
  } catch (error) {
    report.disconnectUpdateCode = typeof error?.code === 'string' ? error.code : String(error);
  }

  try {
    await db.ref('items/dc-remove').onDisconnect().remove();
  } catch (error) {
    report.disconnectRemoveCode = typeof error?.code === 'string' ? error.code : String(error);
  }
} finally {
  await deleteApp(app);
}

console.log(JSON.stringify(report));
process.exit(0);
