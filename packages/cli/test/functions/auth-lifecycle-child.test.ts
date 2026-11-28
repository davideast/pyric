/**
 * Live isolated-child integration tests for Gen 1 Auth `onCreate` / `onDelete`
 * triggers over `pyric sandbox --hosted --bridge --permissive`, verifying both
 * Client SDK and Admin SDK user mutations, absence of false triggers on update,
 * and coexistence with v2 Identity blocking functions.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adminCreateUser,
  adminDeleteUser,
  adminUpdateUser,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth as getClientAuth,
  signInAnonymously,
  type ClientDb,
} from '../../src/serve/worker/client.js';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { connectRemoteSandbox } from '../../src/remote/index.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import {
  childModule,
  createChannelClientPort,
  repoRoot,
  startNodeHostedRuntime,
  type HostedNodeServer,
} from '../functions-identity/hosted-harness.js';

const PROJECT_ID = 'demo-auth-lifecycle-child';

interface RecordedAuthEvent {
  hook: 'onCreate' | 'onDelete' | 'beforeCreate';
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  emailVerified: boolean;
  disabled: boolean;
  providerIds: string[];
  customClaims: Record<string, unknown>;
  creationTime: string | null;
  eventType?: string;
  resourceName?: string;
}

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs = 15_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(40);
  }
  return null;
}

function readRecordedLog(logFile: string): RecordedAuthEvent[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedAuthEvent);
}

function stageFixture(logFile: string): { cwd: string; entry: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-auth-lifecycle-child-'));
  const functionsDir = join(cwd, 'functions');
  mkdirSync(join(cwd, 'public'), { recursive: true });
  mkdirSync(join(functionsDir, 'node_modules'), { recursive: true });
  writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>hosted</body>');
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(functionsDir, 'node_modules/firebase-functions'),
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-admin'),
    join(functionsDir, 'node_modules/firebase-admin'),
  );
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  writeFileSync(
    join(functionsDir, 'package.json'),
    JSON.stringify({ name: 'auth-lifecycle-fixture', private: true, main: 'index.cjs' }),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));

  const entry = join(functionsDir, 'index.cjs');
  writeFileSync(
    entry,
    `const fs = require('node:fs');
const v1 = require('firebase-functions/v1');
const identity = require('firebase-functions/v2/identity');

const LOG_FILE = ${JSON.stringify(logFile)};

function append(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\\n', 'utf8');
}

exports.guardCreate = identity.beforeUserCreated((event) => {
  if (event.data && event.data.email === 'blocked@example.com') {
    throw new identity.HttpsError('permission-denied', 'blocked email');
  }
  append({
    hook: 'beforeCreate',
    uid: event.data ? event.data.uid : '',
    email: event.data && event.data.email !== undefined ? event.data.email : null,
    displayName: null,
    photoURL: null,
    emailVerified: false,
    disabled: false,
    providerIds: [],
    customClaims: {},
    creationTime: null,
  });
  return { customClaims: { enrichedByBlocking: true } };
});

exports.onUserCreate = v1.auth.user().onCreate((user, context) => {
  append({
    hook: 'onCreate',
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    providerIds: (user.providerData || []).map((p) => p.providerId),
    customClaims: user.customClaims || {},
    creationTime: user.metadata ? user.metadata.creationTime : null,
    eventType: context.eventType,
    resourceName: context.resource ? context.resource.name : undefined,
  });
});

exports.onUserDelete = v1.auth.user().onDelete((user, context) => {
  append({
    hook: 'onDelete',
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    providerIds: (user.providerData || []).map((p) => p.providerId),
    customClaims: user.customClaims || {},
    creationTime: user.metadata ? user.metadata.creationTime : null,
    eventType: context.eventType,
    resourceName: context.resource ? context.resource.name : undefined,
  });
});
`,
  );
  return { cwd, entry };
}

describe('Gen 1 Auth onCreate/onDelete isolated child integration', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  test('fires onCreate and onDelete for Client SDK and Admin SDK mutations, ignores updates, and coexists with v2 beforeUserCreated', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pyric-auth-lifecycle-log-'));
    const logFile = join(tmpDir, 'events.ndjson');
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

    const { cwd, entry } = stageFixture(logFile);
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));

    const server: HostedNodeServer = await startNodeHostedRuntime(cwd, PROJECT_ID);
    cleanups.push(() => server.stop());

    const events: FunctionsChildEvent[] = [];
    const childEnv = buildChildEnv(process.env, {
      serveUrl: server.url,
      registerUrl: registerModuleUrl(),
      instanceId: server.instanceId,
      sessionToken: server.sessionToken,
    });
    const child: FunctionsChildHandle = spawnFunctionsChild({
      cwd: join(cwd, 'functions'),
      entry,
      env: childEnv,
      instance: `${PROJECT_ID}-default-rtdb`,
      location: 'us-central1',
      projectId: PROJECT_ID,
      childModuleUrl: childModule,
      onEvent: (event) => events.push(event),
    });
    cleanups.push(() => child.stop());

    const ready = await child.ready;
    expect(ready.triggerCount).toBe(3);
    expect(ready.unsupportedTriggers).toEqual([]);

    const remote = await connectRemoteSandbox({
      url: server.url,
      ...(server.sessionToken === undefined ? {} : { sessionToken: server.sessionToken }),
    });
    cleanups.push(() => remote.close());

    const port = createChannelClientPort(remote);
    const db: ClientDb = { __kind: 'client-db', type: 'firestore', port };
    const clientAuth = getClientAuth(db);

    // 1. Blocked email rejected by v2 beforeUserCreated -> Gen 1 onCreate must NOT fire.
    await expect(
      createUserWithEmailAndPassword(clientAuth, 'blocked@example.com', 'SecretPass123!'),
    ).rejects.toThrow();

    // 2. Client email/password signup -> beforeUserCreated enriches, then Gen 1 onCreate fires.
    const emailCred = await createUserWithEmailAndPassword(
      clientAuth,
      'alice@example.com',
      'SecretPass123!',
    );

    // 3. Admin updateUser -> must NOT fire onCreate or onDelete.
    await adminUpdateUser(clientAuth, emailCred.user.uid, { displayName: 'Alice Updated' });

    // 4. Client anonymous signup -> Gen 1 onCreate fires, then client deleteUser -> Gen 1 onDelete fires.
    const anonCred = await signInAnonymously(clientAuth);
    await deleteUser(anonCred.user);

    // 5. Admin SDK createUser + deleteUser -> both Gen 1 onCreate and onDelete fire.
    const adminCreated = await adminCreateUser(clientAuth, {
      uid: 'admin-created-1',
      email: 'bob@example.com',
      displayName: 'Bob Admin',
      photoUrl: 'https://example.com/bob.png',
      emailVerified: true,
      customClaims: { tier: 'gold' },
    });
    await adminDeleteUser(clientAuth, adminCreated.uid);

    const recorded = await waitFor(() => {
      const rows = readRecordedLog(logFile);
      const lifecycleRows = rows.filter((r) => r.hook === 'onCreate' || r.hook === 'onDelete');
      return lifecycleRows.length >= 5 ? rows : null;
    });
    expect(recorded).not.toBeNull();

    // Give a short quiet window to confirm updateUser / blocked create emitted no extra events.
    await Bun.sleep(150);
    const finalRows = readRecordedLog(logFile);
    const lifecycle = finalRows.filter((r) => r.hook === 'onCreate' || r.hook === 'onDelete');

    expect(lifecycle.map((r) => ({ hook: r.hook, uid: r.uid }))).toEqual([
      { hook: 'onCreate', uid: emailCred.user.uid },
      { hook: 'onCreate', uid: anonCred.user.uid },
      { hook: 'onDelete', uid: anonCred.user.uid },
      { hook: 'onCreate', uid: 'admin-created-1' },
      { hook: 'onDelete', uid: 'admin-created-1' },
    ]);

    const aliceCreate = lifecycle[0];
    expect(aliceCreate?.email).toBe('alice@example.com');
    expect(aliceCreate?.providerIds).toEqual(['password']);
    expect(aliceCreate?.eventType).toBe('google.firebase.auth.user.create');
    expect(aliceCreate?.resourceName).toBe(`projects/${PROJECT_ID}`);
    expect(aliceCreate?.creationTime).toBeTruthy();

    const bobCreate = lifecycle[3];
    expect(bobCreate?.email).toBe('bob@example.com');
    expect(bobCreate?.displayName).toBe('Bob Admin');
    expect(bobCreate?.photoURL).toBe('https://example.com/bob.png');
    expect(bobCreate?.emailVerified).toBe(true);
    expect(bobCreate?.customClaims).toEqual({ tier: 'gold' });

    const bobDelete = lifecycle[4];
    expect(bobDelete?.uid).toBe('admin-created-1');
    expect(bobDelete?.eventType).toBe('google.firebase.auth.user.delete');
    expect(bobDelete?.resourceName).toBe(`projects/${PROJECT_ID}`);

    const executionNames = events
      .filter((e) => e.type === 'execution')
      .map((e) => ({ exportName: e.exportName, ref: e.ref, status: e.status }));
    expect(executionNames).toContainEqual({
      exportName: 'onUserCreate',
      ref: `auth/users/${emailCred.user.uid}`,
      status: 'fulfilled',
    });
    expect(executionNames).toContainEqual({
      exportName: 'onUserDelete',
      ref: 'auth/users/admin-created-1',
      status: 'fulfilled',
    });
  }, 30_000);
});
