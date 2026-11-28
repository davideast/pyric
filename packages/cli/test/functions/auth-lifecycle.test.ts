import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  sandbox as authSandbox,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from 'pyric/auth';
import {
  AUTH_USER_CREATED_EVENT_TYPE,
  AUTH_USER_DELETED_EVENT_TYPE,
  authLifecycleTriggersFamily,
  discoverAuthLifecycleTriggers,
  inspectAuthLifecycleTriggers,
} from '../../src/functions/auth/discovery.js';
import { InMemoryAuthLifecycleTriggerDelivery } from '../../src/functions/auth/delivery.js';
import type { AuthLifecycleUserSnapshot } from '../../src/functions/auth/event.js';
import { startAuthLifecycleTriggerExecution } from '../../src/functions/auth/execution.js';
import { identityBlockingFamily } from '../../src/functions/identity/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';
import {
  cleanupPort,
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type { AuthLifecycleSnapWire } from '../../src/serve/worker/host/auth-lifecycle-subscriptions.js';
import type { OutboundMessage } from '../../src/serve/worker/protocol.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const v1 = requireFromConformance('firebase-functions/v1') as typeof import('firebase-functions/v1');
const v2Identity = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');
const v2Params = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');

function withProjectEnv<T>(projectId: string, fn: () => T): T {
  const prior = process.env.GCLOUD_PROJECT;
  process.env.GCLOUD_PROJECT = projectId;
  try {
    return fn();
  } finally {
    if (prior === undefined) {
      delete process.env.GCLOUD_PROJECT;
    } else {
      process.env.GCLOUD_PROJECT = prior;
    }
  }
}

function makeFakePort(): { port: PortLike; messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  const port: PortLike = {
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
    },
  };
  return { port, messages };
}

function makeSampleUser(overrides: Partial<AuthLifecycleUserSnapshot> = {}): AuthLifecycleUserSnapshot {
  return {
    uid: 'user-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    phoneNumber: '+15550001234',
    photoUrl: 'https://example.com/ada.png',
    customClaims: { role: 'engineer', level: 3 },
    providerUserInfo: [{ providerId: 'password' }, { providerId: 'google.com', uid: 'google-ada' }],
    isAnonymous: false,
    disabled: false,
    emailVerified: true,
    tenantId: null,
    createdAt: '2026-06-01T12:00:00.000Z',
    lastLoginAt: '2026-06-01T12:05:00.000Z',
    tokensValidAfterMs: Date.parse('2026-06-01T12:00:00.500Z'),
    ...overrides,
  };
}

describe('Gen 1 Auth lifecycle trigger discovery', () => {
  test('discovers v1 auth.user().onCreate and onDelete including grouped exports, region, timeout, retry, and omit', () => {
    withProjectEnv('demo-auth-discovery', () => {
      const dynamicRegion = v2Params.defineString('AUTH_REGION');
      const exported = {
        onCreated: v1.auth.user().onCreate(() => undefined),
        onDeleted: v1
          .region('europe-west1')
          .runWith({ timeoutSeconds: 45, failurePolicy: true })
          .auth.user()
          .onDelete(() => undefined),
        nested: {
          auditCreate: v1.auth.user().onCreate(() => undefined),
        },
        omitted: v1.runWith({ omit: true } as never).auth.user().onCreate(() => undefined),
        dynamicReg: v1.region(dynamicRegion as never).auth.user().onCreate(() => undefined),
        blockingV2: v2Identity.beforeUserCreated(() => ({})),
        blockingV1: v1.auth.user().beforeCreate(() => ({})),
      };

      const inspection = inspectAuthLifecycleTriggers(exported);
      expect(
        inspection.triggers.map((t) => ({
          exportName: t.exportName,
          eventType: t.eventType,
          operation: t.operation,
          location: t.location,
          timeoutSeconds: t.timeoutSeconds,
          retry: t.retry,
        })),
      ).toEqual([
        {
          exportName: 'onCreated',
          eventType: AUTH_USER_CREATED_EVENT_TYPE,
          operation: 'create',
          location: undefined,
          timeoutSeconds: undefined,
          retry: false,
        },
        {
          exportName: 'onDeleted',
          eventType: AUTH_USER_DELETED_EVENT_TYPE,
          operation: 'delete',
          location: 'europe-west1',
          timeoutSeconds: 45,
          retry: true,
        },
        {
          exportName: 'nested-auditCreate',
          eventType: AUTH_USER_CREATED_EVENT_TYPE,
          operation: 'create',
          location: undefined,
          timeoutSeconds: undefined,
          retry: false,
        },
      ]);

      expect(inspection.unsupported).toEqual([
        {
          exportName: 'omitted',
          eventType: `${AUTH_USER_CREATED_EVENT_TYPE} (omitted from emulation)`,
        },
        {
          exportName: 'dynamicReg',
          eventType: `${AUTH_USER_CREATED_EVENT_TYPE} (unsupported dynamic region option)`,
        },
      ]);

      expect(
        findUnsupportedTriggers(exported, [authLifecycleTriggersFamily, identityBlockingFamily]),
      ).toEqual([
        {
          exportName: 'omitted',
          eventType: `${AUTH_USER_CREATED_EVENT_TYPE} (omitted from emulation)`,
        },
        {
          exportName: 'dynamicReg',
          eventType: `${AUTH_USER_CREATED_EVENT_TYPE} (unsupported dynamic region option)`,
        },
        {
          exportName: 'blockingV1',
          eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate (v1 auth.user() blocking is not supported)',
        },
      ]);
      expect(discoverAuthLifecycleTriggers(exported)).toHaveLength(3);

      // Dynamic firebase-functions/params expressions resolve against env.
      const resolved = inspectAuthLifecycleTriggers(exported, {
        env: { AUTH_REGION: 'asia-east1' },
      });
      expect(resolved.triggers.map((t) => [t.exportName, t.location])).toContainEqual([
        'dynamicReg',
        'asia-east1',
      ]);
    });
  });
});

describe('Gen 1 Auth lifecycle execution and UserRecord parity', () => {
  test('delivers UserRecord and EventContext parity for user.create and user.delete across sibling triggers', async () => {
    const received: Array<{
      trigger: string;
      user: Record<string, unknown>;
      json: Record<string, unknown>;
      context: Record<string, unknown>;
    }> = [];

    const exported = withProjectEnv('demo-auth-exec', () => ({
      firstCreate: v1.auth.user().onCreate((user, context) => {
        received.push({
          trigger: 'firstCreate',
          user: {
            uid: user.uid,
            email: user.email,
            emailVerified: user.emailVerified,
            displayName: user.displayName,
            photoURL: user.photoURL,
            phoneNumber: user.phoneNumber,
            disabled: user.disabled,
            creationTime: user.metadata.creationTime,
            lastSignInTime: user.metadata.lastSignInTime,
            providerData: user.providerData,
            customClaims: user.customClaims,
            tenantId: user.tenantId,
            tokensValidAfterTime: user.tokensValidAfterTime,
          },
          json: user.toJSON() as Record<string, unknown>,
          context: {
            eventId: context.eventId,
            timestamp: context.timestamp,
            eventType: context.eventType,
            resource: context.resource,
            params: context.params,
          },
        });
      }),
      secondCreate: v1.auth.user().onCreate((user, context) => {
        received.push({
          trigger: 'secondCreate',
          user: { uid: user.uid, tenantId: user.tenantId, email: user.email },
          json: user.toJSON() as Record<string, unknown>,
          context: {
            eventId: context.eventId,
            eventType: context.eventType,
            resource: context.resource,
          },
        });
      }),
      onDelete: v1.auth.user().onDelete((user, context) => {
        received.push({
          trigger: 'onDelete',
          user: { uid: user.uid, email: user.email, tenantId: user.tenantId },
          json: user.toJSON() as Record<string, unknown>,
          context: {
            eventId: context.eventId,
            eventType: context.eventType,
            resource: context.resource,
          },
        });
      }),
    }));

    const delivery = new InMemoryAuthLifecycleTriggerDelivery();
    const outcomes: Array<{ exportName: string; status: string; uid: string }> = [];
    const host = startAuthLifecycleTriggerExecution({
      exported,
      delivery,
      projectId: 'demo-auth-exec',
      eventMetadata: (_notification, sequence) => ({
        eventId: `evt-${sequence}`,
        timestamp: '2026-06-01T12:00:00.000Z',
      }),
      onExecution(result, trigger, notification) {
        outcomes.push({
          exportName: trigger.exportName,
          status: result.status,
          uid: notification.uid,
        });
      },
    });
    await host.ready;

    delivery.emit({
      op: 'user_create',
      uid: 'user-1',
      at: Date.parse('2026-06-01T12:00:00.000Z'),
      user: makeSampleUser(),
    });
    delivery.emit({
      op: 'user_delete',
      uid: 'user-tenant',
      at: Date.parse('2026-06-01T12:10:00.000Z'),
      user: makeSampleUser({
        uid: 'user-tenant',
        email: null,
        displayName: null,
        photoUrl: null,
        phoneNumber: null,
        tenantId: 'tenant-acme',
        providerUserInfo: [],
        customClaims: {},
        lastLoginAt: null,
      }),
    });

    await host.idle();
    host.close();

    expect(outcomes).toEqual([
      { exportName: 'firstCreate', status: 'fulfilled', uid: 'user-1' },
      { exportName: 'secondCreate', status: 'fulfilled', uid: 'user-1' },
      { exportName: 'onDelete', status: 'fulfilled', uid: 'user-tenant' },
    ]);

    expect(received).toHaveLength(3);
    const first = received[0];
    expect(first?.user).toEqual({
      uid: 'user-1',
      email: 'ada@example.com',
      emailVerified: true,
      displayName: 'Ada Lovelace',
      photoURL: 'https://example.com/ada.png',
      phoneNumber: '+15550001234',
      disabled: false,
      creationTime: 'Mon, 01 Jun 2026 12:00:00 GMT',
      lastSignInTime: 'Mon, 01 Jun 2026 12:05:00 GMT',
      providerData: [
        {
          uid: 'ada@example.com',
          providerId: 'password',
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          photoURL: 'https://example.com/ada.png',
          phoneNumber: '+15550001234',
        },
        {
          uid: 'google-ada',
          providerId: 'google.com',
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          photoURL: 'https://example.com/ada.png',
          phoneNumber: '+15550001234',
        },
      ],
      customClaims: { role: 'engineer', level: 3 },
      tenantId: undefined,
      tokensValidAfterTime: 'Mon, 01 Jun 2026 12:00:00 GMT',
    });
    expect(first?.context).toEqual({
      eventId: 'evt-1',
      timestamp: '2026-06-01T12:00:00.000Z',
      eventType: 'google.firebase.auth.user.create',
      resource: {
        service: 'firebaseauth.googleapis.com',
        name: 'projects/demo-auth-exec',
      },
      params: {},
    });
    expect(first?.json.uid).toBe('user-1');

    // Sibling trigger receives its own unmutated legacy context -> converted cleanly too.
    expect(received[1]?.context).toEqual({
      eventId: 'evt-2',
      eventType: 'google.firebase.auth.user.create',
      resource: {
        service: 'firebaseauth.googleapis.com',
        name: 'projects/demo-auth-exec',
      },
    });

    // Deleted tenanted user preserves null scalar defaults and tenantId.
    expect(received[2]?.user).toEqual({
      uid: 'user-tenant',
      email: null,
      tenantId: 'tenant-acme',
    });
    expect(received[2]?.context).toEqual({
      eventId: 'evt-3',
      eventType: 'google.firebase.auth.user.delete',
      resource: {
        service: 'firebaseauth.googleapis.com',
        name: 'projects/demo-auth-exec',
      },
    });
  });

  test('isolates rejected handlers so subsequent lifecycle events still run', async () => {
    const seen: string[] = [];
    const exported = withProjectEnv('demo-auth-err', () => ({
      flakyCreate: v1.auth.user().onCreate((user) => {
        seen.push(user.uid);
        if (user.uid === 'bad-user') {
          throw new Error('simulated failure');
        }
      }),
    }));

    const delivery = new InMemoryAuthLifecycleTriggerDelivery();
    const statuses: string[] = [];
    const host = startAuthLifecycleTriggerExecution({
      exported,
      delivery,
      projectId: 'demo-auth-err',
      eventMetadata: (_n, seq) => ({
        eventId: `err-${seq}`,
        timestamp: '2026-06-01T12:00:00.000Z',
      }),
      onExecution(result) {
        statuses.push(result.status);
      },
    });
    await host.ready;

    delivery.emit({
      op: 'user_create',
      uid: 'bad-user',
      at: Date.now(),
      user: makeSampleUser({ uid: 'bad-user' }),
    });
    delivery.emit({
      op: 'user_create',
      uid: 'good-user',
      at: Date.now(),
      user: makeSampleUser({ uid: 'good-user' }),
    });

    await host.idle();
    host.close();
    expect(seen).toEqual(['bad-user', 'good-user']);
    expect(statuses).toEqual(['rejected', 'fulfilled']);
  });
});

describe('Worker host auth.lifecycle subscription', () => {
  test('requires admin lens, skips history replay, relays only user_create/user_delete, and cleans up on unsub', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    // Pre-existing user before subscription must NOT be replayed.
    authSandbox.createUser(auth, { uid: 'pre-existing', email: 'before@example.com' });

    const ctx: HostCtx = {
      sandbox: sb,
      db: getFirestore(sb),
      instanceId: 'auth-lifecycle-worker-test',
      subs: new Map(),
      flushPersistence: async () => {},
    };

    // Non-admin lens must be rejected.
    const guestPort = makeFakePort();
    await handleMessage(ctx, guestPort.port, {
      t: 'sub',
      subId: 'sub-guest',
      target: { service: 'auth.lifecycle' },
      actAs: { mode: 'anon' },
    });
    expect(guestPort.messages).toHaveLength(1);
    const guestSnap = guestPort.messages[0];
    expect(guestSnap?.t).toBe('snap');
    if (guestSnap?.t === 'snap') {
      expect((guestSnap.value as { __error?: { code?: string } }).__error?.code).toBe(
        'auth/insufficient-permission',
      );
    }

    // Admin lens establishes cleanly with ready snap and zero history replay.
    const adminPort = makeFakePort();
    await handleMessage(ctx, adminPort.port, {
      t: 'sub',
      subId: 'sub-admin',
      target: { service: 'auth.lifecycle' },
      actAs: { mode: 'admin' },
    });
    expect(adminPort.messages).toEqual([
      { t: 'snap', subId: 'sub-admin', value: { kind: 'ready' } },
    ]);

    // Client createUserWithEmailAndPassword -> emits user_create.
    const createdCred = await createUserWithEmailAndPassword(
      auth,
      'client@example.com',
      'SecretPass123!',
    );
    // Client signOut + signInWithEmailAndPassword -> must NOT emit user_create/user_delete.
    await signOut(auth);
    await signInWithEmailAndPassword(auth, 'client@example.com', 'SecretPass123!');
    // Admin updateUser -> must NOT emit user_create/user_delete.
    authSandbox.updateUser(auth, createdCred.user.uid, {
      displayName: 'Updated Client',
      customClaims: { plan: 'pro' },
    });
    // Anonymous signup -> emits user_create.
    const anonCred = await signInAnonymously(auth);
    // Admin createUser -> emits user_create.
    const adminCreated = authSandbox.createUser(auth, {
      uid: 'admin-u1',
      email: 'admin-u1@example.com',
      displayName: 'Admin Created',
      customClaims: { admin: true },
    });
    // Client deleteUser (on anonymous user) + Admin deleteUser -> emit user_delete.
    await deleteUser(anonCred.user);
    authSandbox.deleteUser(auth, adminCreated.uid);

    const mutations = adminPort.messages
      .filter((m): m is Extract<OutboundMessage, { t: 'snap' }> => m.t === 'snap')
      .map((m) => m.value as AuthLifecycleSnapWire)
      .filter((v): v is Extract<AuthLifecycleSnapWire, { kind: 'mutation' }> => v.kind === 'mutation');

    expect(mutations.map((m) => ({ op: m.op, uid: m.uid }))).toEqual([
      { op: 'user_create', uid: createdCred.user.uid },
      { op: 'user_create', uid: anonCred.user.uid },
      { op: 'user_create', uid: 'admin-u1' },
      { op: 'user_delete', uid: anonCred.user.uid },
      { op: 'user_delete', uid: 'admin-u1' },
    ]);
    expect(mutations[2]?.user.customClaims).toEqual({ admin: true });
    expect(mutations[4]?.user.displayName).toBe('Admin Created');

    // Unsubscribe stops further delivery; port cleanup is idempotent.
    await handleMessage(ctx, adminPort.port, { t: 'unsub', subId: 'sub-admin' });
    const countBefore = adminPort.messages.length;
    authSandbox.createUser(auth, { uid: 'after-unsub', email: 'after@example.com' });
    expect(adminPort.messages.length).toBe(countBefore);

    cleanupPort(ctx, adminPort.port);
  });
});
