import assert from 'node:assert/strict';
import { initializeApp, deleteApp, SDK_VERSION } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, signInAnonymously, getIdTokenResult, deleteUser } from 'firebase/auth';
import * as sdk from 'firebase/firestore';
import * as lite from 'firebase/firestore/lite';
import { api, dbName, dbUrl } from '../control.mjs';
import { checkIdentity, target } from '../../../adapters/arcade-sdk/v1/evidence.mjs';
import { errorDetails } from './archive.mjs';

export { sdk, lite, SDK_VERSION, getIdTokenResult };
export const readDocument = path => api(dbUrl + '/documents/' + path);

export async function createDocument(path, fields) {
  await api(dbUrl + '/documents:commit', 'POST', { writes: [{
    update: { name: dbName + '/documents/' + path, fields }, currentDocument: { exists: false },
  }] });
  return readDocument(path);
}

export function clientsFor(runId, journal) {
  assert.equal(SDK_VERSION, target.sdk);
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) assert.ok(!process.env[name], name);
  sdk.setLogLevel('silent');
  lite.setLogLevel('silent');
  const clients = new Map();
  return {
    async add(role, config) {
      assert.ok(!clients.has(role));
      const app = initializeApp(config, runId + '-' + role);
      const client = { app };
      clients.set(role, client);
      const auth = initializeAuth(app, { persistence: inMemoryPersistence });
      client.auth = auth;
      const { user } = await signInAnonymously(auth);
      const { claims, signInProvider } = await getIdTokenResult(user);
      assert.equal(claims.sub, user.uid);
      const identity = { uid: user.uid, audience: claims.aud, issuer: claims.iss, provider: signInProvider };
      checkIdentity(identity);
      for (const other of clients.values()) assert.ok(other.identity?.uid !== identity.uid);
      Object.assign(client, { identity, lite: lite.getFirestore(app, target.database) });
      journal.event('identity', { role, ...identity });
      return client;
    },
    async close() {
      let failed = false;
      for (const [role, { app, auth }] of clients) {
        try {
          if (auth?.currentUser) await deleteUser(auth.currentUser);
        } catch (error) { failed = true; journal.event('identity-cleanup-error', { role, ...errorDetails(error) }); }
        try { await deleteApp(app); }
        catch (error) { failed = true; journal.event('app-cleanup-error', { role, ...errorDetails(error) }); }
      }
      assert.ok(!failed, 'temporary client cleanup failed');
    },
  };
}
