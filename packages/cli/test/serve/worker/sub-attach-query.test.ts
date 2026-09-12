/**
 * A served-mode subscription attaches the query the page built.
 *
 * In served mode the page holds no live ref: it sends a query descriptor and
 * the host rebuilds the query before it attaches. A surface that prints the
 * developer's own call therefore depends on the rebuilt query reaching the
 * attach event — so this covers the descriptor's constraints arriving on
 * `target.query`, for Firestore and for the Realtime Database.
 */

import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { OutboundMessage, TargetDescriptor } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const RTDB_RULES = {
  rules: { '.read': true, '.write': true, presence: { '.indexOn': 'online' } },
};

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(msg: OutboundMessage) { messages.push(msg); } };
}

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  const { getDatabase, sandbox: rtdbSandbox } = await import('pyric/database');
  rtdbSandbox.setRules(getDatabase(sandbox), RTDB_RULES);
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'sub-attach-query-test',
    subs: new Map(),
  };
}

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

/** Frames cross a MessagePort or a socket, so the test sends what survives that. */
function overWire<T>(frame: T): T { return JSON.parse(JSON.stringify(frame)) as T; }

function attachQuery(ctx: HostCtx, kind: 'listener_attach' | 'listener'): unknown {
  const attach = (ctx.sandbox as { history(): readonly unknown[] }).history().find(
    (event) => {
      const candidate = event as { kind?: string; phase?: string };
      return candidate.kind === kind && (kind === 'listener_attach' || candidate.phase === 'attach');
    },
  ) as { target?: { query?: unknown } } | undefined;
  return attach?.target?.query;
}

describe('a served-mode subscription and the query it attaches', () => {
  it('forwards a Firestore query descriptor onto the attach event', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    const target: TargetDescriptor = {
      __ref: 'query',
      source: { __ref: 'collection', path: 'conversations' },
      constraints: [
        { kind: 'where', field: 'members', op: 'array-contains', value: 'u_8f2a' },
        { kind: 'orderBy', field: 'updatedAt', direction: 'desc' },
        { kind: 'limit', n: 50 },
      ],
    };

    await handleMessage(ctx, port, overWire({ t: 'sub', subId: 'sub-1', target }));
    await tick();

    const query = attachQuery(ctx, 'listener_attach') as {
      scope: { kind: string };
      filters: Array<{ field: string; op: string; display: unknown }>;
      orderBy: Array<{ field: string; direction: string }>;
      limit: number | null;
    };
    expect(query.scope.kind).toBe('collection');
    expect(query.filters).toHaveLength(1);
    expect(query.filters[0]!.field).toBe('members');
    expect(query.filters[0]!.op).toBe('array-contains');
    expect(query.filters[0]!.display).toEqual({ type: 'string', value: 'u_8f2a' });
    expect(query.orderBy).toEqual([{ field: 'updatedAt', direction: 'desc' }]);
    expect(query.limit).toBe(50);
  });

  it('forwards a Realtime Database query spec onto the attach target', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await handleMessage(ctx, port, overWire({
      t: 'sub',
      subId: 'sub-2',
      target: {
        service: 'rtdb',
        path: 'presence',
        query: {
          orderBy: { kind: 'child', path: 'online' },
          bounds: [{ kind: 'equalTo', value: true }],
          limit: { kind: 'limitToLast', n: 20 },
        },
      },
    }));
    await tick();

    expect(attachQuery(ctx, 'listener')).toEqual({
      orderBy: { kind: 'child', path: 'online' },
      bounds: [{ kind: 'equalTo', value: true }],
      limit: { kind: 'limitToLast', n: 20 },
    });
  });

  it('leaves a bare collection subscription with no filters to state', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    await handleMessage(ctx, port, overWire({
      t: 'sub',
      subId: 'sub-3',
      target: { __ref: 'collection', path: 'conversations' },
    }));
    await tick();

    const query = attachQuery(ctx, 'listener_attach') as { filters: unknown[] } | undefined;
    expect(query?.filters).toEqual([]);
  });
});
