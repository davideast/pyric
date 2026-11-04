// An HTTP backend as a Firebase app ships it: one onRequest function behind a
// Hosting rewrite, writing Firestore through firebase-admin.
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

exports.api = onRequest(async (req, res) => {
  if (req.method === 'POST' && req.path === '/api/messages') {
    const ref = await getFirestore().collection('messages').add({ text: req.body.text });
    res.status(201).json({ id: ref.id, path: req.path });
    return;
  }
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
});

// An admin job production lets only IAM callers run: pyric serves it to the
// app's own pages and to callers that send no Origin, never to another site.
exports.reset = onRequest({ invoker: 'private' }, (req, res) => {
  res.status(200).json({ reset: true });
});

// A job only the app's backend service account may invoke. Production refuses
// every other caller, so pyric keeps other sites away from it as from reset.
exports.nightly = onRequest({ invoker: 'backend@' }, (req, res) => {
  res.status(200).json({ nightly: true });
});
