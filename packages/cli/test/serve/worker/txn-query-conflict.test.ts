import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
    },
  };
}

type FakePort = ReturnType<typeof fakePort>;

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
    key: `txn-query-conflict-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map() };
}

let seq = 0;
function nextId(): string {
  return `txn-q-${++seq}`;
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: Record<string, unknown>): Promise<ResMessage> {
  const id = nextId();
  await handleMessage(ctx, port, { t: 'op', id, ...msg } as InboundMessage);
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!res) throw new Error(`Missing response for ${id}`);
  return res;
}

describe('worker host txnCommit queryReads conflict validation', () => {
  test('commits when queryReads still match the live query result set', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const res = await sendOp(ctx, port, {
      method: 'txnCommit',
      reads: [],
      queryReads: [
        {
          target: { __ref: 'collection', path: 'orgs/org-1/owners' },
          docPaths: [],
        },
      ],
      writes: [
        { method: 'set', path: 'orgs/org-1/owners/u1', data: { uid: 'u1' } },
      ],
    });

    expect(res.ok).toBe(true);
    expect(ctx.sandbox.admin.getDocument('orgs/org-1/owners/u1')).toEqual({ uid: 'u1' });
  });

  test('aborts without applying writes when a phantom insert changed a read query result set', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    ctx.sandbox.admin.setDocument('orgs/org-1/owners/u1', { uid: 'u1' });

    const res = await sendOp(ctx, port, {
      method: 'txnCommit',
      reads: [],
      queryReads: [
        {
          target: { __ref: 'collection', path: 'orgs/org-1/owners' },
          docPaths: [],
        },
      ],
      writes: [
        { method: 'set', path: 'orgs/org-1/owners/u2', data: { uid: 'u2' } },
      ],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('aborted');
    }
    expect(ctx.sandbox.admin.getDocument('orgs/org-1/owners/u2')).toBeNull();
  });

  test('rejects malformed queryReads payloads with invalid-argument', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    const nonArrayRes = await sendOp(ctx, port, {
      method: 'txnCommit',
      reads: [],
      queryReads: 'not-an-array',
      writes: [],
    });
    expect(nonArrayRes.ok).toBe(false);
    if (!nonArrayRes.ok) {
      expect(nonArrayRes.error.code).toBe('invalid-argument');
    }

    const docTargetRes = await sendOp(ctx, port, {
      method: 'txnCommit',
      reads: [],
      queryReads: [
        {
          target: { __ref: 'doc', path: 'orgs/org-1/owners/u1' },
          docPaths: [],
        },
      ],
      writes: [],
    });
    expect(docTargetRes.ok).toBe(false);
    if (!docTargetRes.ok) {
      expect(docTargetRes.error.code).toBe('invalid-argument');
    }
  });
});
