/**
 * Bootstraps the admin/prod inputs `composeMcpRegistry` needs from a service
 * account: an admin App + `scope`, a user-impersonation Firestore factory, and
 * an RTDB host. Standard SDK plumbing (createCustomToken -> signInWithCustomToken
 * -> FirebaseServerApp), cached per (uid, claims).
 *
 * Used by the project-audit skill and firestore-path discovery to reach a real
 * project. Previously inlined in the (now-removed) standalone MCP binary.
 */
import admin from 'firebase-admin';
import { initializeApp as initializeClientApp, initializeServerApp } from 'firebase/app';
import { getAuth as getClientAuth, signInWithCustomToken } from 'firebase/auth';
import { getFirestore as getClientFirestore } from 'firebase/firestore';
import {
  get as getClientData,
  getDatabase as getClientDatabase,
  push as pushClientData,
  ref as clientDataRef,
  remove as removeClientData,
  set as setClientData,
  update as updateClientData,
  type Database,
  type DatabaseReference,
} from 'firebase/database';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { initializeDatabaseApp, type RtdbHost } from 'pyric/database';
import type { ProjectScope } from '../credentials/core/types.js';
import { projectScopeFromAdminApp } from '../credentials/node/admin-app-scope.js';
import type { AdminAppDeps } from './compose.js';
import { createFirebaseRtdbDataTransport } from './rtdb-data-transport.js';

export interface AdminDepsResult {
  scope: ProjectScope;
  adminDeps: AdminAppDeps;
  rtdbHost: RtdbHost;
}

interface ImpersonationAuth {
  uid: string;
  claims?: Record<string, unknown>;
}

/**
 * @param saBase64 base64-encoded service account JSON.
 * @param apiKey   Web API key — required only for user-mode (`as:{uid}`) operations.
 */
export function adminDepsFromServiceAccount(opts: {
  saBase64: string;
  apiKey?: string;
}): AdminDepsResult {
  if (!opts.saBase64) throw new Error('adminDepsFromServiceAccount: saBase64 is required');
  const cert = JSON.parse(Buffer.from(opts.saBase64, 'base64').toString('utf-8'));
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert(cert),
        projectId: cert.project_id,
      });

  const scope = projectScopeFromAdminApp(app);
  const apiKey = opts.apiKey ?? '';
  const databaseUrl = `https://${cert.project_id}-default-rtdb.firebaseio.com`;
  const clientApp = initializeClientApp(
    { apiKey, projectId: cert.project_id, authDomain: `${cert.project_id}.firebaseapp.com` },
    'pyric-impersonation',
  );
  const serverAppCache = new Map<string, ReturnType<typeof initializeServerApp>>();
  const getOrCreateServerApp = async (auth: ImpersonationAuth) => {
    if (!apiKey) throw new Error('apiKey is required for user-mode operations.');
    const key = `${auth.uid}:${JSON.stringify(auth.claims ?? {})}`;
    const cached = serverAppCache.get(key);
    if (cached) return cached;
    const customToken = await admin.auth(app).createCustomToken(auth.uid, auth.claims);
    const cred = await signInWithCustomToken(getClientAuth(clientApp), customToken);
    const authIdToken = await cred.user.getIdToken();
    const serverApp = initializeServerApp(
      { apiKey, projectId: cert.project_id, authDomain: `${cert.project_id}.firebaseapp.com` },
      { authIdToken },
    );
    await getClientAuth(serverApp).authStateReady();
    serverAppCache.set(key, serverApp);
    return serverApp;
  };

  return {
    scope,
    adminDeps: {
      adminApp: app,
      getClientFirestore: async (auth) => getClientFirestore(await getOrCreateServerApp(auth)),
    },
    rtdbHost: initializeDatabaseApp({
      projectId: cert.project_id,
      getRestToken: () => scope.resolveToken(),
      getUserToken: async (auth: ImpersonationAuth) => {
        const customToken = await admin.auth(app).createCustomToken(auth.uid, auth.claims);
        const cred = await signInWithCustomToken(getClientAuth(clientApp), customToken);
        return cred.user.getIdToken();
      },
      data: createFirebaseRtdbDataTransport({
        databaseUrl,
        getAdminDatabase: (url) => getDatabaseWithUrl(url, app),
        getClientDatabase: async (auth: ImpersonationAuth, url: string) =>
          getClientDatabase(await getOrCreateServerApp(auth), url),
        client: {
          ref: (database, path) => clientDataRef(database as Database, path),
          get: (reference) => getClientData(reference as DatabaseReference),
          set: (reference, value) => setClientData(reference as DatabaseReference, value),
          update: (reference, values) =>
            updateClientData(reference as DatabaseReference, values),
          push: (reference, value) =>
            pushClientData(reference as DatabaseReference, value),
          remove: (reference) => removeClientData(reference as DatabaseReference),
        },
      }),
    }, { databaseUrl }),
  };
}
