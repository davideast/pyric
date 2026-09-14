import { getAuth } from 'firebase/auth';
import { getDoc as upstreamGetDoc, type DocumentData, type DocumentReference } from 'firebase/firestore';
import { recordLiveRequest } from '../../live/capture.js';

export { connectFirestoreEmulator, doc, DocumentSnapshot, getFirestore } from 'firebase/firestore';
export type { DocumentData, DocumentReference, Firestore } from 'firebase/firestore';

/** Return the original SDK snapshot; observing a read never invokes its converter. */
export async function getDoc<AppModel, DbModel extends DocumentData>(reference: DocumentReference<AppModel, DbModel>) {
  const at = Date.now();
  const user = getAuth(reference.firestore.app).currentUser;
  const hasUser = user !== null;
  const auth = hasUser ? { uid: user.uid } : null;
  const snapshot = await upstreamGetDoc(reference);
  const isFromCache = snapshot.metadata.fromCache;
  recordLiveRequest({
    kind: 'request',
    id: crypto.randomUUID(),
    at,
    evalMs: 0,
    method: 'get',
    path: reference.path,
    auth,
    result: 'allow',
    reasons: [],
    origin: 'user',
    rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
    detail: {
      live: true,
      projectId: reference.firestore.app.options.projectId,
      observedAt: Date.now(),
      source: isFromCache ? 'cache' : 'server',
      hasPendingWrites: snapshot.metadata.hasPendingWrites,
    },
  });
  return snapshot;
}
