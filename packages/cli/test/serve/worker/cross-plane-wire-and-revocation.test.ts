import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import {
  collection as ipCollection,
  getDocs as ipGetDocs,
  getFirestore as ipGetFirestore,
  onSnapshot as ipOnSnapshot,
} from 'pyric/firestore';
import {
  get as ipRtdbGet,
  getDatabase as ipGetDatabase,
  onValue as ipRtdbOnValue,
  ref as ipRtdbRef,
  sandbox as rtdbSandbox,
  set as ipRtdbSet,
} from 'pyric/database';
import { setRules as setSandboxFirestoreRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, getStorageService } from 'pyric/storage/internal';
import * as client from '../../../src/serve/worker/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { restoreFirestoreSubscriptions } from '../../../src/serve/worker/host/subscriptions.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import { serializeError, type InboundMessage, type OutboundMessage, type SnapMessage } from '../../../src/serve/worker/protocol.js';
import { snapshotError } from '../../../src/serve/worker/outbound-validation.js';
import { buildReproFile, captureReproBase } from '../../../src/serve/repro/capture.js';
import { createReproRecorder } from '../../../src/serve/repro/recorder.js';
import { connectClientToHost, makeHostCtx, portPair, until } from './integration-support.js';

let previousWorker: unknown;

beforeEach(() => {
  previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
});

afterEach(() => {
  client.setLens(undefined);
  (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker;
});

describe('Cross-plane worker wire error revival and subscription revocation parity', () => {
  it('preserves top-level remediation, queryProof, rule, request, and query fields across worker getDocs and onSnapshot', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`;
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: `repro-scrub-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    ipGetAuth(sandbox);
    const storageService = await getStorageService(getAdminStorageSandbox(sandbox));
    storageService.backend.references = async () => [];
    const ctx: HostCtx = {
      db: ipGetFirestore(sandbox),
      sandbox,
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
    };
    try {
      setSandboxFirestoreRules(ctx.sandbox, rules);
      const { db } = connectClientToHost(ctx, `worker://wire-query-proof-${Math.random()}`);
      client.setLens({ mode: 'as', uid: 'user-1' });

      // Compare against in-process Firestore error shape for the same user identity.
      const ipDb = ipGetFirestore(ctx.sandbox.withAuth({ uid: 'user-1' }));
      let ipErr: Record<string, unknown> | undefined;
      try {
        await ipGetDocs(ipCollection(ipDb, 'items'));
      } catch (e) {
        ipErr = e as Record<string, unknown>;
      }
      expect(ipErr).toBeDefined();
      expect(typeof ipErr!.remediation).toBe('string');
      expect((ipErr!.denialContext as { queryProof?: unknown })?.queryProof).toBeDefined();

      let workerReadErr: Record<string, unknown> | undefined;
      try {
        await client.getDocs(client.collection(db, 'items'));
      } catch (e) {
        workerReadErr = e as Record<string, unknown>;
      }
      expect(workerReadErr).toBeInstanceOf(FirebaseError);
      expect(workerReadErr!.remediation).toBe(ipErr!.remediation);
      expect(workerReadErr!.denialContext).toEqual(ipErr!.denialContext);
      expect(workerReadErr!.customData).toEqual(ipErr!.customData);

      const ipListenerErrs: Record<string, unknown>[] = [];
      const stopIp = ipOnSnapshot(
        ipCollection(ipDb, 'items'),
        () => {},
        (err) => ipListenerErrs.push(err as unknown as Record<string, unknown>),
      );
      const workerListenerErrs: Record<string, unknown>[] = [];
      const stopWorker = client.onSnapshot(
        client.collection(db, 'items'),
        () => {},
        (err) => workerListenerErrs.push(err as unknown as Record<string, unknown>),
      );
      await until(() => ipListenerErrs.length >= 1 && workerListenerErrs.length >= 1, 'listener query-proof errors');
      stopIp();
      stopWorker();

      expect(workerListenerErrs[0]).toBeInstanceOf(FirebaseError);
      expect(workerListenerErrs[0]!.remediation).toBe(ipListenerErrs[0]!.remediation);
      expect(workerListenerErrs[0]!.denialContext).toEqual(ipListenerErrs[0]!.denialContext);
      expect(workerListenerErrs[0]!.customData).toEqual(ipListenerErrs[0]!.customData);
      expect(workerListenerErrs[0]!.request).toEqual({ method: 'list', path: 'items' });

      // Additive ADR-0011 SerializedError & snapshotError fields round-trip when present on top-level error.
      const decorated = Object.assign(new Error('list denied'), {
        code: 'permission-denied',
        remediation: 'Add where("ownerId", "==", uid)',
        queryProof: { kind: 'constraints-not-satisfied', failures: [] },
        rule: { line: 5, expression: 'resource.data.ownerId == request.auth.uid' },
        request: { method: 'list', path: '/items' },
        resource: { exists: true, data: { ownerId: 'u1' } },
        query: { limitCount: 10 },
      });
      const serialized = serializeError(decorated);
      expect(serialized).toMatchObject({
        code: 'permission-denied',
        remediation: 'Add where("ownerId", "==", uid)',
        queryProof: { kind: 'constraints-not-satisfied', failures: [] },
        rule: { line: 5, expression: 'resource.data.ownerId == request.auth.uid' },
        request: { method: 'list', path: '/items' },
        resource: { exists: true, data: { ownerId: 'u1' } },
        query: { limitCount: 10 },
      });
      expect(snapshotError({ value: { __error: serialized } })).toMatchObject({
        code: 'permission-denied',
        remediation: 'Add where("ownerId", "==", uid)',
        queryProof: { kind: 'constraints-not-satisfied', failures: [] },
        rule: { line: 5, expression: 'resource.data.ownerId == request.auth.uid' },
        request: { method: 'list', path: '/items' },
        resource: { exists: true, data: { ownerId: 'u1' } },
        query: { limitCount: 10 },
      });
    } finally {
      getInternalEnv(ctx.sandbox).dispose();
    }
  });

  it('preserves plain Error (not FirebaseError) with code PERMISSION_DENIED on served RTDB operations and listeners', async () => {
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: `repro-scrub-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    ipGetAuth(sandbox);
    const storageService = await getStorageService(getAdminStorageSandbox(sandbox));
    storageService.backend.references = async () => [];
    const ctx: HostCtx = {
      db: ipGetFirestore(sandbox),
      sandbox,
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
    };
    try {
      const rtdbRules = {
        rules: {
          items: {
            $id: {
              '.read': 'auth != null',
              '.write': 'auth != null',
            },
          },
        },
      };
      setDatabaseRules(ctx, undefined, rtdbRules);
      const { db } = connectClientToHost(ctx, `worker://rtdb-plain-error-${Math.random()}`);
      const rtdb = client.rtdbGetDatabase(db);
      const ipDb = ipGetDatabase(ctx.sandbox.withAuth(null));

      let ipGetErr: (Error & { code?: string }) | undefined;
      try {
        await ipRtdbGet(ipRtdbRef(ipDb, 'items/item-1'));
      } catch (e) {
        ipGetErr = e as Error & { code?: string };
      }
      expect(ipGetErr).toBeInstanceOf(Error);
      expect(ipGetErr).not.toBeInstanceOf(FirebaseError);
      expect(ipGetErr!.name).toBe('Error');
      expect(ipGetErr!.constructor.name).toBe('Error');
      expect(ipGetErr!.code).toBe('PERMISSION_DENIED');

      let servedGetErr: (Error & { code?: string }) | undefined;
      try {
        await client.rtdbGet(client.rtdbRef(rtdb, 'items/item-1'));
      } catch (e) {
        servedGetErr = e as Error & { code?: string };
      }
      expect(servedGetErr).toBeInstanceOf(Error);
      expect(servedGetErr).not.toBeInstanceOf(FirebaseError);
      expect(servedGetErr!.name).toBe('Error');
      expect(servedGetErr!.constructor.name).toBe('Error');
      expect(servedGetErr!.code).toBe('PERMISSION_DENIED');

      let servedSetErr: (Error & { code?: string }) | undefined;
      try {
        await client.rtdbSet(client.rtdbRef(rtdb, 'items/item-1'), { title: 'blocked' });
      } catch (e) {
        servedSetErr = e as Error & { code?: string };
      }
      expect(servedSetErr).toBeInstanceOf(Error);
      expect(servedSetErr).not.toBeInstanceOf(FirebaseError);
      expect(servedSetErr!.name).toBe('Error');
      expect(servedSetErr!.constructor.name).toBe('Error');
      expect(servedSetErr!.code).toBe('PERMISSION_DENIED');

      const ipCancelErr = await new Promise<Error & { code?: string }>((resolve) => {
        ipRtdbOnValue(ipRtdbRef(ipDb, 'items/item-1'), () => {}, resolve);
      });
      const servedCancelErr = await new Promise<Error & { code?: string }>((resolve) => {
        client.rtdbOnValue(client.rtdbRef(rtdb, 'items/item-1'), () => {}, resolve);
      });
      expect(servedCancelErr).toBeInstanceOf(Error);
      expect(servedCancelErr).not.toBeInstanceOf(FirebaseError);
      expect(servedCancelErr.name).toBe(ipCancelErr.name);
      expect(servedCancelErr.constructor.name).toBe('Error');
      expect(servedCancelErr.code).toBe('PERMISSION_DENIED');
    } finally {
      getInternalEnv(ctx.sandbox).dispose();
    }
  });

  it('purges revoked and initially denied Firestore subscriptions on the host and prevents setLens resurrection of cancelled RTDB listeners', async () => {
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: `repro-scrub-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    ipGetAuth(sandbox);
    const storageService = await getStorageService(getAdminStorageSandbox(sandbox));
    storageService.backend.references = async () => [];
    const ctx: HostCtx = {
      db: ipGetFirestore(sandbox),
      sandbox,
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
    };
    try {
      const openRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;
      const closedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if false;
      allow write: if request.auth != null;
    }
  }
}`;
      setSandboxFirestoreRules(ctx.sandbox, openRules);

      const snaps: SnapMessage[] = [];
      const hostPort: PortLike = {
        postMessage(msg: OutboundMessage) {
          if (msg.t === 'snap') snaps.push(msg);
        },
      };

      // 1. Initial Firestore denial while signed out must not leave intent registered.
      await handleMessage(ctx, hostPort, {
        t: 'sub',
        subId: 'fs-initial-denied',
        target: { __ref: 'doc', path: 'items/item-1' },
      });
      await until(
        () => snaps.some((s) => s.subId === 'fs-initial-denied' && (s.value as { __error?: unknown })?.__error !== undefined),
        'initial denied snap',
      );
      expect(ctx.subs.get(hostPort)?.has('fs-initial-denied') ?? false).toBe(false);

      // Sign in on the port; fs-initial-denied must not resurrect.
      await handleMessage(ctx, hostPort, { t: 'op', id: 'op-signin-1', method: 'auth.signInAnonymously' });
      await handleMessage(ctx, hostPort, {
        t: 'op',
        id: 'op-seed-1',
        method: 'setDoc',
        path: 'items/item-1',
        data: { title: 'first' },
      });
      expect(snaps.filter((s) => s.subId === 'fs-initial-denied')).toHaveLength(1);

      // 2. Allowed Firestore listener revoked by rules tightening must be purged from host subs + intents.
      await handleMessage(ctx, hostPort, {
        t: 'sub',
        subId: 'fs-revoked',
        target: { __ref: 'doc', path: 'items/item-1' },
      });
      await until(() => snaps.some((s) => s.subId === 'fs-revoked'), 'initial allowed snap');
      setSandboxFirestoreRules(ctx.sandbox, closedRules);
      await until(
        () => snaps.some((s) => s.subId === 'fs-revoked' && (s.value as { __error?: unknown })?.__error !== undefined),
        'revoked snap',
      );
      expect(ctx.subs.get(hostPort)?.has('fs-revoked') ?? false).toBe(false);

      // Restore open rules and trigger both session transition and restoreFirestoreSubscriptions:
      // fs-revoked must stay dead even without a client unsub frame.
      const countAfterRevoke = snaps.filter((s) => s.subId === 'fs-revoked').length;
      setSandboxFirestoreRules(ctx.sandbox, openRules);
      restoreFirestoreSubscriptions(ctx);
      await handleMessage(ctx, hostPort, { t: 'op', id: 'op-signout-1', method: 'auth.signOut' });
      await handleMessage(ctx, hostPort, { t: 'op', id: 'op-signin-2', method: 'auth.signInAnonymously' });
      await handleMessage(ctx, hostPort, {
        t: 'op',
        id: 'op-seed-2',
        method: 'setDoc',
        path: 'items/item-1',
        data: { title: 'second' },
      });
      expect(snaps.filter((s) => s.subId === 'fs-revoked')).toHaveLength(countAfterRevoke);

      // 3. Cancelled served RTDB listener must not resurrect when setLens switches to admin.
      setDatabaseRules(ctx, undefined, {
        rules: {
          items: { '.read': false, '.write': true },
          marker: { '.read': true, '.write': true },
        },
      });
      const { db } = connectClientToHost(ctx, `worker://rtdb-lens-no-resurrect-${Math.random()}`);
      const rtdb = client.rtdbGetDatabase(db);
      rtdbSandbox.setData(ipGetDatabase(ctx.sandbox), { '/items/a': 1, '/marker': 'start' });

      const cancelledEvents: string[] = [];
      client.rtdbOnValue(
        client.rtdbRef(rtdb, 'items'),
        (snap) => cancelledEvents.push(`val:${JSON.stringify(snap.val())}`),
        (err) => cancelledEvents.push(`err:${(err as { code?: string }).code}`),
      );
      await until(() => cancelledEvents.length >= 1, 'initial RTDB denial');
      expect(cancelledEvents).toEqual(['err:PERMISSION_DENIED']);

      const markerEvents: string[] = [];
      const stopMarker = client.rtdbOnValue(client.rtdbRef(rtdb, 'marker'), (snap) => {
        markerEvents.push(String(snap.val()));
      });
      client.setLens({ mode: 'admin' });
      await client.rtdbSet(client.rtdbRef(rtdb, 'items/a'), 2);
      await client.rtdbSet(client.rtdbRef(rtdb, 'marker'), 'after-lens');
      await until(() => markerEvents.includes('after-lens'), 'marker after setLens');
      stopMarker();

      expect(cancelledEvents).toEqual(['err:PERMISSION_DENIED']);
    } finally {
      getInternalEnv(ctx.sandbox).dispose();
    }
  });

  it('preserves email claims, paths, and query values in wire error frames while stripping non-email profile/envelope token claims and standard session claims', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid && request.auth.token.role != 'blocked@example.com' && request.auth.token.email.matches('.*@example.com');
    }
    match /users/{email}/notes/{noteId} {
      allow read: if false;
    }
  }
}`;
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: `repro-scrub-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    ipGetAuth(sandbox);
    const storageService = await getStorageService(getAdminStorageSandbox(sandbox));
    storageService.backend.references = async () => [];
    const ctx: HostCtx = {
      db: ipGetFirestore(sandbox),
      sandbox,
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
    };
    try {
      setSandboxFirestoreRules(ctx.sandbox, rules);
      const outboundFrames: OutboundMessage[] = [];
      const { a: clientPort, b: hostPort } = portPair();
      let recorder: ReturnType<typeof createReproRecorder> | undefined;
      const hostPortLike: PortLike = {
        postMessage(message: OutboundMessage) {
          outboundFrames.push(message);
          recorder?.outbound('tab-1', message);
          hostPort.postMessage(message);
        },
      };
      hostPort.onmessage = (event) => {
        const inbound = event.data as InboundMessage;
        void (async () => {
          await recorder?.inbound('tab-1', inbound);
          await handleMessage(ctx, hostPortLike, inbound);
        })();
      };
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = clientPort;
        constructor(_url: unknown, _opts: unknown) {}
      };

      const url = `worker://wire-scrub-${Math.random()}`;
      const db = client.getFirestore(url);
      const auth = client.getAuth(url);

      const created = await client.adminCreateUser(auth, {
        uid: 'user-42',
        email: 'ada@example.com',
        password: 'password-123',
        emailVerified: true,
        displayName: 'Ada Member',
      });
      await client.adminUpdateUser(auth, created.uid, {
        customClaims: { role: 'member', pkgVersion: 'pkg@1.2.3', schemaTag: 'v1@2.0' },
      });
      await client.signInWithEmailAndPassword(auth, 'ada@example.com', 'password-123');

      // Start the repro recorder after sign-in so the capture records session + denied queries/listeners.
      recorder = createReproRecorder({
        capture: () => captureReproBase(ctx, [['tab-1', hostPortLike]]),
      });
      outboundFrames.length = 0;

      let readErr: Record<string, unknown> | undefined;
      try {
        await client.getDocs(client.collection(db, 'items'));
      } catch (e) {
        readErr = e as Record<string, unknown>;
      }
      expect(readErr).toBeInstanceOf(FirebaseError);
      expect(String(readErr!.remediation)).toContain(".where('ownerId', '==', request.auth.uid)");
      expect(String(readErr!.remediation)).toContain('Reproduce with:');
      expect((readErr!.denialContext as { queryProof?: unknown })?.queryProof).toBeDefined();
      expect((readErr!.denialContext as { rule?: { expression?: string } })?.rule?.expression).toContain(
        ".matches('.*@example.com')",
      );
      expect((readErr!.denialContext as { rule?: { expression?: string } })?.rule?.expression).toContain(
        "'blocked@example.com'",
      );
      const expectedWireToken = {
        email: 'ada@example.com',
        email_verified: true,
        role: 'member',
        pkgVersion: 'pkg@1.2.3',
        schemaTag: 'v1@2.0',
        firebase: {
          identities: { email: ['ada@example.com'] },
          sign_in_provider: 'password',
        },
      };
      expect(
        (readErr!.denialContext as { auth?: { uid?: string; token?: Record<string, unknown> } })?.auth,
      ).toEqual({
        uid: 'user-42',
        token: expectedWireToken,
      });
      expect(
        (
          readErr!.denialContext as {
            repro?: { testCase?: { auth?: Record<string, unknown> } };
          }
        )?.repro?.testCase?.auth,
      ).toEqual({
        uid: 'user-42',
        token: expectedWireToken,
      });

      const snapErrors: Record<string, unknown>[] = [];
      const stopList = client.onSnapshot(
        client.collection(db, 'items'),
        () => {},
        (err) => snapErrors.push(err as unknown as Record<string, unknown>),
      );
      await until(() => snapErrors.length >= 1, 'denied list listener error');
      stopList();

      const reproLog = await recorder.log();
      const reproFile = await buildReproFile(reproLog, () => undefined);
      expect(reproFile.entries.length).toBeGreaterThan(0);
      expect(reproFile.base.sessions['tab-1']).toEqual({
        uid: 'user-42',
        tenantId: null,
        signInProvider: 'password',
        customClaims: {
          role: 'member',
          pkgVersion: 'pkg@1.2.3',
          schemaTag: 'v1@2.0',
        },
      });

      // Verify path emails and escaped JSON inside --query '...' and Fixture case: stay intact in remediation.
      const pathEmailErrors: Record<string, unknown>[] = [];
      const stopEmailPath = client.onSnapshot(
        client.doc(db, 'users/ada@example.com/notes/1'),
        () => {},
        (err) => pathEmailErrors.push(err as unknown as Record<string, unknown>),
      );
      await until(() => pathEmailErrors.length >= 1, 'denied email-path listener error');
      stopEmailPath();

      let queryWithEmailErr: Record<string, unknown> | undefined;
      try {
        await client.getDocs(
          client.query(
            client.collection(db, 'items'),
            client.where('ownerEmail', '==', 'ada@example.com'),
            client.where('escapedJson', '==', JSON.stringify({ contact: 'ada@example.com' })),
          ),
        );
      } catch (e) {
        queryWithEmailErr = e as Record<string, unknown>;
      }
      expect(queryWithEmailErr).toBeInstanceOf(FirebaseError);
      const queryRemediation = String(queryWithEmailErr!.remediation);
      const cliQueryMatch = /--query '([^']+)'/.exec(queryRemediation);
      expect(cliQueryMatch).not.toBeNull();
      const parsedCliQuery = JSON.parse(cliQueryMatch![1]!) as {
        where: Array<{ field: string; op: string; value: string }>;
      };
      expect(parsedCliQuery).toEqual({
        where: [
          { field: 'ownerEmail', op: '==', value: 'ada@example.com' },
          { field: 'escapedJson', op: '==', value: '{"contact":"ada@example.com"}' },
        ],
      });
      expect(JSON.parse(parsedCliQuery.where[1]!.value)).toEqual({ contact: 'ada@example.com' });
      const fixtureLine = queryRemediation
        .split('\n')
        .find((line) => line.startsWith('  Fixture case: '));
      expect(fixtureLine).toBeDefined();
      const parsedFixture = JSON.parse(fixtureLine!.slice('  Fixture case: '.length)) as {
        auth?: Record<string, unknown>;
        query?: unknown;
      };
      expect(parsedFixture.query).toEqual({
        where: [
          { field: 'ownerEmail', op: '==', value: 'ada@example.com' },
          { field: 'escapedJson', op: '==', value: '{"contact":"ada@example.com"}' },
        ],
      });
      expect(parsedFixture.auth).toEqual({
        uid: 'user-42',
        token: expectedWireToken,
      });

      expect(snapErrors[0]!.request).toEqual({ method: 'list', path: 'items' });
      expect(snapErrors[0]!.queryProof).toBeDefined();
      expect((snapErrors[0]!.rule as { expression?: string })?.expression).toContain("'blocked@example.com'");
      expect((snapErrors[0]!.rule as { expression?: string })?.expression).toContain(
        ".matches('.*@example.com')",
      );
      expect(String(snapErrors[0]!.remediation)).toContain(".where('ownerId', '==', request.auth.uid)");
      expect(
        (snapErrors[0]!.denialContext as { auth?: { uid?: string; token?: Record<string, unknown> } })?.auth,
      ).toEqual({
        uid: 'user-42',
        token: expectedWireToken,
      });
      expect(pathEmailErrors[0]!.request).toEqual({
        method: 'get',
        path: 'users/ada@example.com/notes/1',
      });

      // Verify tenanted token promotion and email preservation directly on serializeError:
      const syntheticSerialized = serializeError(
        Object.assign(new Error('Denied (contact ops@example.com) at render@app.bundle.js:10:2 for pkg@1.2.3 / v1@2.0'), {
          code: 'permission-denied',
          denialContext: {
            engine: 'firestore',
            auth: {
              uid: 'user-99',
              token: {
                email: 'ada@example.com',
                email_verified: true,
                phone_number: '+15550100',
                name: 'Ada',
                picture: 'https://example.com/p.png',
                uid: 'user-99',
                user_id: 'user-99',
                sub: 'user-99',
                iss: 'https://securetoken.google.com/pyric-sandbox',
                aud: 'pyric-sandbox',
                iat: 100,
                exp: 200,
                auth_time: 100,
                nonce: 'n-1',
                role: 'viewer',
                firebase: {
                  identities: { email: ['ada@example.com'], 'google.com': ['g-1'] },
                  sign_in_provider: 'password',
                  tenant: 'tenant-west',
                },
              },
            },
            reasons: [
              "rule request.auth.token.email.matches('.*@example.com') failed (contact ops@example.com) at render@app.bundle.js:10:2 [pkg@1.2.3, v1@2.0]",
            ],
          },
        }),
      );
      expect(syntheticSerialized.message).toBe(
        'Denied (contact ops@example.com) at render@app.bundle.js:10:2 for pkg@1.2.3 / v1@2.0',
      );
      expect(syntheticSerialized.denialContext).toEqual({
        engine: 'firestore',
        auth: {
          uid: 'user-99',
          tenant: 'tenant-west',
          token: {
            email: 'ada@example.com',
            email_verified: true,
            role: 'viewer',
            firebase: {
              identities: { email: ['ada@example.com'] },
              sign_in_provider: 'password',
              tenant: 'tenant-west',
            },
          },
        },
        reasons: [
          "rule request.auth.token.email.matches('.*@example.com') failed (contact ops@example.com) at render@app.bundle.js:10:2 [pkg@1.2.3, v1@2.0]",
        ],
      } as unknown as typeof syntheticSerialized.denialContext);

      const wireText = JSON.stringify(outboundFrames);
      expect(() => JSON.parse(wireText)).not.toThrow();
      expect(wireText).toContain('ada@example.com');
      expect(wireText).toContain('blocked@example.com');
      expect(wireText).toContain('pkg@1.2.3');
      expect(wireText).toContain('v1@2.0');
      expect(wireText).toContain(".matches('.*@example.com')");
      expect(wireText).toContain('"sign_in_provider":"password"');
      for (const claim of [
        'phone_number',
        'name',
        'picture',
        'auth_time',
        'user_id',
        'sub',
        'iss',
        'aud',
        'iat',
        'exp',
        'nonce',
      ]) {
        expect(wireText).not.toContain(`"${claim}":`);
        expect(wireText).not.toContain(`\\"${claim}\\":`);
      }

      const sessionsText = JSON.stringify(reproFile.base.sessions);
      expect(sessionsText).not.toContain('ada@example.com');
      expect(sessionsText).toContain('pkg@1.2.3');
      expect(sessionsText).toContain('v1@2.0');
      for (const claim of [
        'email',
        'email_verified',
        'phone_number',
        'name',
        'picture',
        'auth_time',
        'identities',
        'user_id',
        'sub',
        'iss',
        'aud',
        'iat',
        'exp',
        'nonce',
      ]) {
        expect(sessionsText).not.toContain(`"${claim}":`);
        expect(sessionsText).not.toContain(`\\"${claim}\\":`);
      }
    } finally {
      getInternalEnv(ctx.sandbox).dispose();
    }
  });

  it('prevents served Firestore client.onSnapshot from resurrecting on client.setLens after initial or mid-stream permission-denied', async () => {
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({
      key: `repro-scrub-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    ipGetAuth(sandbox);
    const storageService = await getStorageService(getAdminStorageSandbox(sandbox));
    storageService.backend.references = async () => [];
    const ctx: HostCtx = {
      db: ipGetFirestore(sandbox),
      sandbox,
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
    };
    try {
      const signedInReadRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null;
      allow write: if true;
    }
    match /markers/{id} {
      allow read, write: if true;
    }
  }
}`;
      const denyItemReadRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if false;
      allow write: if true;
    }
    match /markers/{id} {
      allow read, write: if true;
    }
  }
}`;
      setSandboxFirestoreRules(ctx.sandbox, signedInReadRules);
      const { db } = connectClientToHost(ctx, `worker://fs-lens-no-resurrect-${Math.random()}`);

      // Seed protected item first under admin lens, then switch to anonymous.
      client.setLens({ mode: 'admin' });
      await client.setDoc(client.doc(db, 'items/secret-1'), { label: 'initial-secret' });
      await client.setDoc(client.doc(db, 'markers/m1'), { step: 'seeded' });
      client.setLens({ mode: 'anon' });

      // 1. Initially denied client.onSnapshot must not resurrect when setLens switches to admin.
      const initialDeniedSnaps: unknown[] = [];
      const initialDeniedErrs: string[] = [];
      client.onSnapshot(
        client.doc(db, 'items/secret-1'),
        (snap) => initialDeniedSnaps.push(snap.data()),
        (err) => initialDeniedErrs.push((err as { code?: string }).code ?? 'unknown'),
      );
      await until(() => initialDeniedErrs.length >= 1, 'initial Firestore onSnapshot denial');
      expect(initialDeniedErrs).toEqual(['permission-denied']);
      expect(initialDeniedSnaps).toEqual([]);

      const markerSteps: string[] = [];
      const stopMarker = client.onSnapshot(client.doc(db, 'markers/m1'), (snap) => {
        const step = (snap.data() as { step?: string } | undefined)?.step;
        if (step !== undefined) markerSteps.push(step);
      });
      await until(() => markerSteps.includes('seeded'), 'marker seeded');

      client.setLens({ mode: 'admin' });
      await client.setDoc(client.doc(db, 'items/secret-1'), { label: 'updated-under-admin' });
      await client.setDoc(client.doc(db, 'markers/m1'), { step: 'after-admin-lens' });
      await until(() => markerSteps.includes('after-admin-lens'), 'marker after admin lens');
      expect(initialDeniedSnaps).toEqual([]);

      // 2. Mid-stream revoked client.onSnapshot must not resurrect when setLens switches to admin.
      client.setLens({ mode: 'as', uid: 'user-1' });
      const revokedSnaps: unknown[] = [];
      const revokedErrs: string[] = [];
      client.onSnapshot(
        client.doc(db, 'items/secret-1'),
        (snap) => revokedSnaps.push(snap.data()),
        (err) => revokedErrs.push((err as { code?: string }).code ?? 'unknown'),
      );
      await until(() => revokedSnaps.length >= 1, 'initial allowed Firestore snapshot');
      expect(revokedSnaps).toEqual([{ label: 'updated-under-admin' }]);

      setSandboxFirestoreRules(ctx.sandbox, denyItemReadRules);
      await until(() => revokedErrs.length >= 1, 'mid-stream Firestore revocation');
      expect(revokedErrs).toEqual(['permission-denied']);

      client.setLens({ mode: 'admin' });
      await client.setDoc(client.doc(db, 'items/secret-1'), { label: 'post-revoke-secret' });
      await client.setDoc(client.doc(db, 'markers/m1'), { step: 'after-revoke-lens' });
      await until(() => markerSteps.includes('after-revoke-lens'), 'marker after revoke lens');
      stopMarker();

      expect(revokedSnaps).toEqual([{ label: 'updated-under-admin' }]);
      expect(initialDeniedSnaps).toEqual([]);
    } finally {
      getInternalEnv(ctx.sandbox).dispose();
    }
  });
});
