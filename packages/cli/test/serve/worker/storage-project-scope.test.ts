/**
 * Worker init — storage IndexedDB project scoping (issue #359, defect B).
 *
 * `applyServeInit` opens the sandbox's ONE storage service with the init
 * payload's `projectKey`, so the worker lands on `pyric-storage:<projectKey>`
 * instead of the legacy origin-shared `pyric-storage` database. Two projects
 * served (sequentially) on one origin must not see each other's objects; the
 * same project must keep seeing its own.
 *
 * fake-indexeddb is process-global, which stands in for the browser's
 * origin-scoped registry: pre-fix, all ctxs here shared one database and the
 * cross-project read below saw the other project's object.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import { applyServeInit } from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';

function payloadFor(projectKey: string): InitPayload {
  return {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    projectKey,
    bridgeUrl: null,
    seed: null,
    seedState: null,
    authUsers: null,
  };
}

/** A worker ctx booted for `projectKey` — mirrors entry.ts: build ctx, then
 *  applyServeInit (which claims the project-scoped storage DB name). */
function makeCtx(projectKey: string): HostCtx {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `scope-${projectKey}`,
    subs: new Map(),
  };
  applyServeInit(ctx, payloadFor(projectKey), { fetch: (() => {}) as unknown as typeof fetch });
  return ctx;
}

let opSeq = 0;
function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, {
      ...payload,
      t: 'op',
      id: `pop-${++opSeq}`,
    } as InboundMessage);
  });
}

const ADMIN = { actAs: { mode: 'admin' } } as const;

describe('worker storage db project scoping', () => {
  it('two projectKeys open isolated storage databases; the same key shares', async () => {
    const keyA = `/proj/a-${Math.random().toString(36).slice(2, 8)}`;
    const keyB = `/proj/b-${Math.random().toString(36).slice(2, 8)}`;

    const ctxA = makeCtx(keyA);
    const put = await op(ctxA, {
      method: 'storage.putBytes',
      path: 'uploads/logo.png',
      dataB64: bytesToBase64(new Uint8Array([1, 2, 3])),
      ...ADMIN,
    });
    expect(put.ok).toBe(true);

    // A DIFFERENT project on the same origin must not see the object.
    const readB = await op(makeCtx(keyB), {
      method: 'storage.getBytes',
      path: 'uploads/logo.png',
      ...ADMIN,
    });
    expect(readB.ok).toBe(false);
    if (!readB.ok) expect(readB.error.code).toBe('storage/object-not-found');

    // The SAME project (fresh worker boot) keeps its data.
    const readA = await op(makeCtx(keyA), {
      method: 'storage.getBytes',
      path: 'uploads/logo.png',
      ...ADMIN,
    });
    expect(readA.ok).toBe(true);
  });
});
