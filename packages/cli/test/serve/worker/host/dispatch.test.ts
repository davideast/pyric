import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { monitorFirebaseActivity, type ActivityIncident } from 'pyric/firestore/internal';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import type { OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import type { HostCtx, PortLike } from '../../../../src/serve/worker/host-context.js';
import { handleMessage } from '../../../../src/serve/worker/host/dispatch.js';

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
    key: `dispatch-activity-${Math.random()}`,
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

describe('activity dispatch', () => {
  it('segments repeated reads by page port', async () => {
    const ctx = await makeCtx();
    const firstPage = fakePort();
    const secondPage = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);

    for (let index = 0; index < 4; index += 1) {
      await handleMessage(ctx, firstPage, {
        t: 'op', id: `before-reload-${index}`, method: 'getDoc', path: 'items/reload',
      });
    }
    await handleMessage(ctx, secondPage, {
      t: 'op', id: 'after-reload', method: 'getDoc', path: 'items/reload',
    });
    expect(incidents).toEqual([]);

    await handleMessage(ctx, firstPage, {
      t: 'op', id: 'first-page-threshold', method: 'getDoc', path: 'items/reload',
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.actor).toMatchObject({ kind: 'app', journeyId: 'page-1' });
    guard.dispose();
  });

  it('detects recreated array-valued query reads across the worker boundary', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);
    const source = {
      __ref: 'query' as const,
      source: { __ref: 'collection' as const, path: 'items' },
      constraints: [{ kind: 'where' as const, field: 'status', op: 'in', value: ['open'] }],
    };

    for (let index = 0; index < 5; index += 1) {
      await handleMessage(ctx, port, {
        t: 'op', id: `array-read-${index}`, method: 'getDocs', source: structuredClone(source),
      });
    }

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ pattern: 'repeated-read', count: 5, confidence: 'high' });
    guard.dispose();
  });

  it('keeps different array and map query operands distinct', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);

    for (let index = 0; index < 5; index += 1) {
      await handleMessage(ctx, port, {
        t: 'op', id: `array-${index}`, method: 'getDocs',
        source: {
          __ref: 'query', source: { __ref: 'collection', path: 'items' },
          constraints: [{ kind: 'where', field: 'status', op: 'in', value: [`value-${index}`] }],
        },
      });
      await handleMessage(ctx, port, {
        t: 'op', id: `map-${index}`, method: 'getDocs',
        source: {
          __ref: 'query', source: { __ref: 'collection', path: 'profiles' },
          constraints: [{ kind: 'where', field: 'profile', op: '==', value: { role: `role-${index}` } }],
        },
      });
    }

    expect(incidents).toEqual([]);
    guard.dispose();
  });

  it('detects recreated map and typed query operands', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const incidents: ActivityIncident[] = [];
    const guard = monitor(ctx, incidents);
    const cases: Array<{ name: string; value: unknown }> = [
      { name: 'map', value: { role: 'admin' } },
      { name: 'timestamp', value: { __type: 'timestamp', seconds: 1, nanos: 2 } },
      { name: 'bytes', value: { __type: 'bytes', base64: 'AQID' } },
      { name: 'latlng', value: { __type: 'latlng', lat: 1, lng: 2 } },
    ];

    for (const testCase of cases) {
      for (let index = 0; index < 5; index += 1) {
        await handleMessage(ctx, port, {
          t: 'op', id: `${testCase.name}-${index}`, method: 'getDocs',
          source: {
            __ref: 'query', source: { __ref: 'collection', path: `items-${testCase.name}` },
            constraints: [{
              kind: 'where', field: 'value', op: '==', value: structuredClone(testCase.value),
            }],
          },
        });
      }
    }

    expect(incidents).toHaveLength(cases.length);
    expect(incidents.every(
      (incident) => incident.pattern === 'repeated-read' && incident.count === 5,
    )).toBe(true);
    guard.dispose();
  });
});
