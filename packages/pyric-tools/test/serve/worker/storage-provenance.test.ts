/**
 * Storage-op PROVENANCE across the async dispatch boundary (worker host).
 *
 * THE BUG THIS PINS (issue #84 item 3 — async provenance for service ops):
 * op provenance (`actor`, `authLens`) is stamped via the sandbox's SYNCHRONOUS
 * ambient-provenance window (`runWithProvenance`), opened by `handleMessage`
 * around `dispatchMessage`. Firestore/RTDB/auth emit their events
 * synchronously inside that window, so the stamp lands. STORAGE ops dispatch
 * ASYNCHRONOUSLY — `uploadBytes`/`deleteObject` await the backend
 * (getMetadata → put/delete) before emitting the `service_mutation` event. By
 * the time the emit runs, `runWithProvenance`'s synchronous `finally` has
 * already restored the ambient window, so the storage event escapes it and a
 * Studio-issued upload lands with NO `actor` — silently misattributed as
 * app-session traffic.
 *
 * THE INTERLEAVING HAZARD (why "just widen the window to await fn" is wrong):
 * two ops from different issuers can be in flight concurrently. If the window
 * stayed open across awaits, op A's window would still be ambient when op B's
 * event emits — swapping actors. The fix must BIND provenance at issue time
 * and thread it through the async dispatch explicitly, so concurrent ops never
 * cross-contaminate.
 *
 * FIX UNDER TEST: `handleMessage`/`handleOp` capture the op's provenance
 * (issuer → actor, actAs → authLens) at issue time and bind it to an
 * operation-scoped Storage handle before the first await. The service reads
 * that immutable binding when it emits, independent of the ambient window.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, toOperationRecord, type SandboxEvent } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

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
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';

let dbSeq = 0;
function uniqueDbName(): string {
  return `pyric-storage-prov-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeCtx(): { ctx: HostCtx; events: SandboxEvent[] } {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: uniqueDbName() });
  const events: SandboxEvent[] = [];
  sandbox.onEvent((e) => events.push(e));
  return {
    ctx: { db: getFirestore(sandbox), sandbox, instanceId: 'storage-prov-test', subs: new Map() },
    events,
  };
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
      id: `spop-${++opSeq}`,
    } as InboundMessage);
  });
}

const DATA = bytesToBase64(new TextEncoder().encode('payload'));

/** All `object_put` mutation events for a given path. */
function putsFor(events: SandboxEvent[], path: string): SandboxEvent[] {
  return events.filter(
    (e) =>
      e.kind === 'service_mutation' &&
      (e as { op?: string }).op === 'object_put' &&
      (e as { path?: string }).path === path,
  );
}

describe('worker host: storage op provenance survives async dispatch', () => {
  it('records a Studio/admin list with source and bypass disposition intact', async () => {
    const { ctx, events } = makeCtx();
    const res = await op(ctx, {
      method: 'storage.listAll',
      path: 'notes',
      issuer: 'studio',
      actAs: { mode: 'admin' },
    });
    expect(res.ok).toBe(true);

    const event = events.find(
      (candidate) =>
        candidate.kind === 'operation'
        && candidate.service === 'storage'
        && candidate.method === 'list',
    );
    expect(event).toBeDefined();
    const record = toOperationRecord(event!);
    expect(record?.context).toEqual({
      source: { kind: 'studio' },
      authLens: { mode: 'admin' },
    });
    expect(record?.rules).toEqual({ kind: 'bypassed', reason: 'admin' });
  });

  it('stamps actor:{kind:"studio"} on a Studio-issued upload event', async () => {
    const { ctx, events } = makeCtx();
    const res = await op(ctx, {
      method: 'storage.putBytes',
      path: 'studio/blob.bin',
      dataB64: DATA,
      issuer: 'studio',
    });
    expect(res.ok).toBe(true);

    const puts = putsFor(events, 'studio/blob.bin');
    expect(puts.length).toBeGreaterThan(0);
    for (const e of puts) {
      expect(e.actor).toEqual({ kind: 'studio' });
    }
  });

  it('records a served-app upload (no issuer) as app traffic', async () => {
    const { ctx, events } = makeCtx();
    const res = await op(ctx, {
      method: 'storage.putBytes',
      path: 'app/blob.bin',
      dataB64: DATA,
    });
    expect(res.ok).toBe(true);

    const puts = putsFor(events, 'app/blob.bin');
    expect(puts.length).toBeGreaterThan(0);
    for (const e of puts) {
      expect(e.actor).toEqual({ kind: 'app' });
      expect(e.operationContext?.source).toEqual({ kind: 'app' });
    }
  });

  it('two concurrent uploads from different issuers do not swap actors', async () => {
    const { ctx, events } = makeCtx();
    // Issue BOTH before awaiting either — their async backend windows overlap.
    // A naive "widen the ambient window across awaits" fix would let the
    // app op's event emit while the studio window is still ambient (or vice
    // versa), swapping actors. Explicit per-op binding must keep them distinct.
    const [studioRes, appRes] = await Promise.all([
      op(ctx, { method: 'storage.putBytes', path: 'race/studio.bin', dataB64: DATA, issuer: 'studio' }),
      op(ctx, { method: 'storage.putBytes', path: 'race/app.bin', dataB64: DATA }),
    ]);
    expect(studioRes.ok).toBe(true);
    expect(appRes.ok).toBe(true);

    const studioPuts = putsFor(events, 'race/studio.bin');
    const appPuts = putsFor(events, 'race/app.bin');
    expect(studioPuts.length).toBeGreaterThan(0);
    expect(appPuts.length).toBeGreaterThan(0);
    for (const e of studioPuts) expect(e.actor).toEqual({ kind: 'studio' });
    for (const e of appPuts) {
      expect(e.actor).toEqual({ kind: 'app' });
      expect(e.operationContext?.source).toEqual({ kind: 'app' });
    }
  });

  it('an admin-lens delete carries authLens:{mode:"admin"} on its event (bypass classification)', async () => {
    const { ctx, events } = makeCtx();
    // Seed then delete under the admin lens; the delete event must carry the
    // lens it ran under so Traffic classifies the BYPASS correctly — the
    // storage mirror of the Firestore lens-provenance guarantee.
    await op(ctx, { method: 'storage.putBytes', path: 'admin/gone.bin', dataB64: DATA, actAs: { mode: 'admin' } });
    const res = await op(ctx, {
      method: 'storage.deleteObject',
      path: 'admin/gone.bin',
      actAs: { mode: 'admin' },
    });
    expect(res.ok).toBe(true);

    const deletes = events.filter(
      (e) =>
        e.kind === 'service_mutation' &&
        (e as { op?: string }).op === 'object_delete' &&
        (e as { path?: string }).path === 'admin/gone.bin',
    );
    expect(deletes.length).toBeGreaterThan(0);
    for (const e of deletes) {
      expect(e.authLens).toEqual({ mode: 'admin' });
    }
  });
});
