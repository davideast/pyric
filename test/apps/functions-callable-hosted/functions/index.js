const { HttpsError, onCall } = require('firebase-functions/v2/https');
const functionsV1 = require('firebase-functions/v1');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

exports.saveItem = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const title = String(request.data?.title ?? '');
  if (!title) {
    throw new HttpsError('invalid-argument', 'Title is required.');
  }
  const ref = await getFirestore().collection('items').add({
    title,
    ownerUid: request.auth.uid,
  });
  return { id: ref.id, ownerUid: request.auth.uid };
});

exports.streamItems = onCall({ heartbeatSeconds: 1 }, async (request, response) => {
  const count = Number(request.data?.count ?? 2);
  for (let i = 1; i <= count; i += 1) {
    await response.sendChunk({ index: i });
  }
  return { sent: count };
});

exports.legacyEcho = functionsV1.https.onCall((data, context) => ({
  data,
  uid: context.auth?.uid ?? null,
}));
