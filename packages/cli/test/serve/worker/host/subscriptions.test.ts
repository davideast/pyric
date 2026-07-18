import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { monitorFirebaseActivity, type ActivityIncident } from 'pyric/firestore/internal';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import type { OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import type { HostCtx, PortLike } from '../../../../src/serve/worker/host-context.js';
import { cleanupPort, handleMessage } from '../../../../src/serve/worker/host/dispatch.js';

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if true; }
    }
  }
`;

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (message) => messages.push(message) };
}

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `subscription-activity-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map(), instanceId: 'test' };
}

function monitor(ctx: HostCtx, incidents: ActivityIncident[]) {
  return monitorFirebaseActivity(
    {
      history: () => ctx.sandbox.history(),
      subscribe: (listener) => ctx.sandbox.onEvent(listener),
    },
    (incident) => incidents.push(incident),
  );
}

describe('activity subscription accounting', () => {
  it('keeps duplicate listeners independent for concurrent page ports', async () => {
    const ctx = await makeCtx();
    const firstPage = fakePort();
    const secondPage = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);

    await handleMessage(ctx, firstPage, {
      t: 'sub', subId: 'first-1', target: { __ref: 'doc', path: 'items/shared' },
    });
    await handleMessage(ctx, firstPage, {
      t: 'sub', subId: 'first-2', target: { __ref: 'doc', path: 'items/shared' },
    });
    await handleMessage(ctx, secondPage, {
      t: 'sub', subId: 'second-1', target: { __ref: 'doc', path: 'items/shared' },
    });
    expect(incidents).toEqual([]);

    await handleMessage(ctx, firstPage, {
      t: 'sub', subId: 'first-3', target: { __ref: 'doc', path: 'items/shared' },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      pattern: 'duplicate-listener', actor: { kind: 'app', journeyId: 'page-1' },
    });

    cleanupPort(ctx, firstPage);
    cleanupPort(ctx, secondPage);
    guard.dispose();
  });

  it('preserves page attribution when auth re-registers a live listener', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);

    await handleMessage(ctx, port, {
      t: 'sub', subId: 'before-auth', target: { __ref: 'doc', path: 'items/shared' },
    });
    await handleMessage(ctx, port, {
      t: 'op', id: 'sign-in', method: 'auth.signInAnonymously',
    });
    await handleMessage(ctx, port, {
      t: 'sub', subId: 'after-auth-1', target: { __ref: 'doc', path: 'items/shared' },
    });
    await handleMessage(ctx, port, {
      t: 'sub', subId: 'after-auth-2', target: { __ref: 'doc', path: 'items/shared' },
    });

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      pattern: 'duplicate-listener',
      count: 3,
      actor: { kind: 'app', journeyId: 'page-1' },
      listenerBalance: { attaches: 2, detaches: 0, active: 3 },
    });

    cleanupPort(ctx, port);
    guard.dispose();
  });

  it('detects recreated array-valued listeners across the worker boundary', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);
    const target = {
      __ref: 'query' as const,
      source: { __ref: 'collection' as const, path: 'items' },
      constraints: [{ kind: 'where' as const, field: 'status', op: 'in', value: ['open'] }],
    };

    for (let index = 0; index < 3; index += 1) {
      await handleMessage(ctx, port, {
        t: 'sub', subId: `array-listener-${index}`, target: structuredClone(target),
      });
    }

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      pattern: 'duplicate-listener', count: 3, confidence: 'medium',
    });

    cleanupPort(ctx, port);
    guard.dispose();
  });
});
