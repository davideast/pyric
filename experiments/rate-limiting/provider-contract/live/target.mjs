import { readFile } from 'node:fs/promises';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { googleApi } from '../../../shared/observability/google-api.mjs';
import { validateConfig } from './config.mjs';

const errorCode = error => typeof error?.code === 'string' && /^[a-zA-Z0-9/_-]{1,100}$/.test(error.code) ? error.code : 'request-failed';
export async function inspectTarget(config, { credentials, firebaseConfigPath = undefined }) {
    validateConfig(config);
    if (Object.keys(process.env).some(k => /EMULATOR_HOST$/.test(k) && process.env[k])) throw new Error('Emulator overrides are forbidden for live runs');
    if (!credentials) throw new Error('Explicit service-account path required outside capture');
    const key = JSON.parse(await readFile(credentials, 'utf8'));
    if (key.project_id !== config.projectId || key.type !== 'service_account') throw new Error('Credential project does not match target');
    const api = await googleApi({ project: config.projectId, credentials });
    const requiredPermissions = ['datastore.databases.get', 'datastore.databases.getMetadata', 'datastore.entities.get', 'datastore.entities.create', 'datastore.entities.update'];
    const allowed = await api.request('POST', `https://cloudresourcemanager.googleapis.com/v1/projects/${config.projectId}:testIamPermissions`, { permissions: requiredPermissions });
    if (requiredPermissions.some(p => !allowed.permissions?.includes(p))) throw new Error('Service account lacks required Firestore read/write permissions');
    const database = await api.request('GET', `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.databaseId}`);
    if (database.type !== 'FIRESTORE_NATIVE' || database.concurrencyMode !== 'PESSIMISTIC') throw new Error('Expected native Firestore with pessimistic concurrency');
    const webConfig = firebaseConfigPath ? JSON.parse(await readFile(firebaseConfigPath, 'utf8')) : await (async () => {
        const response = await fetch(`https://${config.projectId}.web.app/__/firebase/init.json`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) throw new Error('Provide --firebase-config from the Firebase console');
        return response.json();
    })();
    if (webConfig.projectId !== config.projectId || webConfig.appId !== config.appId || typeof webConfig.apiKey !== 'string') throw new Error('Firebase web configuration does not match target');
    return { publicReport: { ready: true, projectId: config.projectId, databaseId: config.databaseId, locationId: database.locationId, concurrencyMode: database.concurrencyMode,
        appId: config.appId, model: config.model, transport: 'local controller → Firebase AI Logic; Firestore Admin gRPC', deployment: false, credentialsExcluded: true }, webConfig, key };
}
export async function connectTarget(config, options) {
    const target = await inspectTarget(config, options);
    const app = initializeApp({ projectId: config.projectId, credential: cert(target.key) }, `provider-contract-data-${crypto.randomUUID()}`);
    const db = getFirestore(app, config.databaseId);
    return { db, apiKey: target.webConfig.apiKey, environment: target.publicReport, close: () => deleteApp(app) };
}
export async function prepareIdentity(config, { authCredentials, apiKey, runId }) {
    const key = JSON.parse(await readFile(authCredentials, 'utf8'));
    if (key.project_id !== config.projectId || key.type !== 'service_account') throw new Error('Auth credential project mismatch');
    const app = initializeApp({ projectId: config.projectId, credential: cert(key) }, `provider-contract-auth-${runId}`);
    const auth = getAuth(app), uid = `provider-contract-${runId}`; let created = false; let phase = 'create-user';
    const close = async () => { try { if (created) await auth.deleteUser(uid); } finally { await deleteApp(app); } };
    try {
        await auth.createUser({ uid, displayName: 'Synthetic provider contract experiment' }); created = true;
        phase = 'custom-token'; const customToken = await auth.createCustomToken(uid);
        phase = 'token-exchange'; const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        });
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('firebase-sign-in-failed'), { code: `auth-http-${response.status}` }); }
        const signedIn = await response.json();
        if (!signedIn.idToken) throw new Error('missing-id-token');
        phase = 'verify-identity';
        const verified = await auth.verifyIdToken(signedIn.idToken);
        if (verified.uid !== uid) throw new Error('unexpected-auth-identity');
        phase = 'app-check'; const appCheck = await getAppCheck(app).createToken(config.appId, { ttlMillis: 1800000 });
        const tokens = { idToken: signedIn.idToken, appCheckToken: appCheck.token };
        return { credentials: async () => tokens, close };
    } catch (error) {
        await close(); throw new Error('Synthetic identity preparation failed at ' + phase + ': ' + errorCode(error));
    }
}
