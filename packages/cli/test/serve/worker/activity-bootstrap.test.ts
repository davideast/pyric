import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { primeEventHistory } from 'pyric/sandbox/internal';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import { setupFirebaseActivityGuard } from '../../../src/serve/worker/activity-bootstrap.js';
import type { OutboundMessage } from '../../../src/serve/worker/protocol.js';

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if true; }
    }
  }
`;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `activity-bootstrap-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map() };
}

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (message) => void messages.push(message) };
}

function recordingFetch(): typeof fetch & { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = ((url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return Promise.resolve({ ok: true, status: 204 } as Response);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Firebase Activity Guard', () => {
  it('posts one warning for a repeated app read through the real worker host', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const monitor = setupFirebaseActivityGuard(ctx, { fetch: fetchSpy }, 'activity-test-token');
    const port = fakePort();

    for (let index = 0; index < 7; index += 1) {
      await handleMessage(ctx, port, {
        t: 'op',
        id: `read-${index}`,
        method: 'getDoc',
        path: 'users/alice',
      });
    }
    await tick(0);

    const warnings = fetchSpy.calls.filter((call) => call.url === '/__pyric/activity');
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!.body)).toMatchObject({
      pattern: 'repeated-read',
      service: 'firestore',
      usage: { unit: 'document-reads', lowerBound: 5 },
    });
    monitor!.dispose();
  });

  it('attributes normal worker subscriptions to the app and warns on duplicates', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const monitor = setupFirebaseActivityGuard(ctx, { fetch: fetchSpy }, 'activity-test-token');
    const port = fakePort();

    for (let index = 0; index < 3; index += 1) {
      await handleMessage(ctx, port, {
        t: 'sub',
        subId: `listener-${index}`,
        target: { __ref: 'doc', path: 'users/alice' },
      });
    }
    await tick(0);

    const warnings = fetchSpy.calls.filter((call) => call.url === '/__pyric/activity');
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!.body)).toMatchObject({
      pattern: 'duplicate-listener',
      service: 'firestore',
      usage: { unit: 'listener-attaches', lowerBound: 3 },
    });
    monitor!.dispose();
  });

  it('correlates worker cleanup events and warns on listener churn', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const monitor = setupFirebaseActivityGuard(ctx, { fetch: fetchSpy }, 'activity-test-token');
    const port = fakePort();

    for (let index = 0; index < 4; index += 1) {
      const subId = `churn-${index}`;
      await handleMessage(ctx, port, {
        t: 'sub',
        subId,
        target: { __ref: 'doc', path: 'users/alice' },
      });
      if (index < 3) await handleMessage(ctx, port, { t: 'unsub', subId });
    }
    await tick(0);

    const warnings = fetchSpy.calls.filter((call) => call.url === '/__pyric/activity');
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!.body)).toMatchObject({
      pattern: 'listener-churn',
      service: 'firestore',
      usage: { unit: 'listener-attaches', lowerBound: 4 },
    });
    monitor!.dispose();
  });

  it('excludes Studio and admin-lens worker listeners', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const monitor = setupFirebaseActivityGuard(ctx, { fetch: fetchSpy }, 'activity-test-token');
    const port = fakePort();

    for (let index = 0; index < 3; index += 1) {
      await handleMessage(ctx, port, {
        t: 'sub',
        subId: `studio-${index}`,
        target: { __ref: 'doc', path: 'studio/doc' },
        issuer: 'studio',
      });
      await handleMessage(ctx, port, {
        t: 'sub',
        subId: `admin-${index}`,
        target: { __ref: 'doc', path: 'admin/doc' },
        actAs: { mode: 'admin' },
      });
    }
    await tick(0);

    expect(fetchSpy.calls.filter((call) => call.url === '/__pyric/activity')).toEqual([]);
    monitor!.dispose();
  });

  it('does not let hydrated reads prime a warning in the fresh worker segment', async () => {
    const ctx = await makeCtx();
    const historicalReads = Array.from({ length: 5 }, (_, index) => ({
      kind: 'request' as const,
      id: `historical-${index}`,
      at: 100 + index,
      evalMs: 1,
      method: 'get' as const,
      path: 'users/alice',
      auth: null,
      result: 'allow' as const,
      reasons: [],
      origin: 'user' as const,
      operationContext: {
        source: { kind: 'app' as const },
        authLens: { mode: 'app-session' as const },
      },
    }));
    primeEventHistory(ctx.sandbox, historicalReads);
    const fetchSpy = recordingFetch();
    const monitor = setupFirebaseActivityGuard(ctx, { fetch: fetchSpy }, 'activity-test-token');
    const port = fakePort();

    await handleMessage(ctx, port, {
      t: 'op', id: 'fresh-1', method: 'getDoc', path: 'users/alice',
    });
    await tick(0);
    expect(fetchSpy.calls.filter((call) => call.url === '/__pyric/activity')).toEqual([]);

    for (let index = 2; index <= 5; index += 1) {
      await handleMessage(ctx, port, {
        t: 'op', id: `fresh-${index}`, method: 'getDoc', path: 'users/alice',
      });
    }
    await tick(0);
    expect(fetchSpy.calls.filter((call) => call.url === '/__pyric/activity')).toHaveLength(1);
    monitor!.dispose();
  });
});
