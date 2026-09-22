import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export function createFirestoreAdminBackend({ projectId, databaseId }) {
    if (!projectId || !databaseId) throw new Error('Explicit projectId and databaseId required');
    const app = getApps()[0] ?? initializeApp({ projectId, credential: applicationDefault() });
    const db = getFirestore(app, databaseId);
    return { app, db };
}
