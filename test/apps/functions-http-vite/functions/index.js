// An HTTP backend as a Firebase app ships it: one onRequest function behind a
// Hosting rewrite, writing Firestore through firebase-admin.
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

exports.api = onRequest(async (req, res) => {
  if (req.method === 'POST' && req.path === '/api/messages') {
    const ref = await getFirestore().collection('messages').add({
      text: req.body.text,
      cookie: req.get('cookie') ?? null,
    });
    res.status(201).json({ id: ref.id, path: req.path });
    return;
  }
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
});
