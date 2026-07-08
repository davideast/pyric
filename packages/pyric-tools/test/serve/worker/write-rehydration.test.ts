/**
 * Host-side WRITE-payload rehydration (remote sandbox slice 2; spike gap 4).
 *
 * THE BUG UNDER TEST
 * ------------------
 * Over the JSON relay legs a Node-side `Timestamp`/`Bytes`/`GeoPoint` arrives
 * as its `toJSON()` marker object. The host used to run only
 * `resolveSentinels` on write data, so the marker was STORED as a plain map.
 * Reads masked it (the read path rehydrates), but anything that consumes the
 * STORED value inside the worker saw a map:
 *   - a rules expression like `request.resource.data.when is timestamp`
 *     evaluated FALSE, and
 *   - `orderBy` over the field used map ordering, not timestamp ordering.
 *
 * These tests drive the REAL host with JSON-round-tripped op frames (both
 * marker families: pyric `{ __type: 'timestamp' }` and firebase
 * `{ type: 'firestore/timestamp/1.0' }`) across EVERY write-bearing op —
 * setDoc / updateDoc / addDoc / batchCommit / txnCommit — and prove the
 * stored value is a real Timestamp via a type-asserting write rule and a
 * chronological orderBy whose map-ordering answer would differ.
 */

import { describe, it, expect } from 'bun:test';
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
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

// Write rule that TYPE-ASSERTS the stored form: a marker-left-as-map makes
// `is timestamp` false, so the pre-fix host DENIES these writes.
const TIMESTAMP_GATED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /events/{id} {
      allow read: if true;
      allow create, update: if request.resource.data.when is timestamp;
    }
    match /free/{id} {
      allow read, write: if true;
    }
  }
}`;

// ─── Harness (host.test.ts style, + JSON round-trip on every frame) ─────────

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(msg: OutboundMessage) { messages.push(msg); } };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(TIMESTAMP_GATED_RULES);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'write-rehydration-test', subs: new Map() };
}

function tick(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }

let _seq = 0;
function id(): string { return `rehy-op-${++_seq}`; }

/** Model the WS legs: the op frame must survive JSON serialization. */
function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, overWire(msg));
  await tick();
  const opId = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === opId);
  if (!res) throw new Error(`No res for ${opId}`);
  return res;
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

/** The pyric wrapper marker family (`Timestamp.toJSON()` / persistence). */
function pyricMarker(seconds: number, nanos: number): Record<string, unknown> {
  return { __type: 'timestamp', seconds, nanos };
}

/** The firebase SDK marker family (`fb.Timestamp.toJSON()`). */
function fbMarker(seconds: number, nanoseconds: number): Record<string, unknown> {
  return { type: 'firestore/timestamp/1.0', seconds, nanoseconds };
}

/** Assert a read-back JSON node is a serialized TIMESTAMP (either marker
 *  family — the read path currently emits the firebase family) with the
 *  given seconds (omit to accept any, e.g. a resolved serverTimestamp). */
function expectTimestampMarker(v: Record<string, unknown>, seconds?: number): void {
  const isTs = v.__type === 'timestamp' || v.type === 'firestore/timestamp/1.0';
  expect(isTs).toBe(true);
  if (seconds !== undefined) expect(v.seconds).toBe(seconds);
}

// ════════════════════════════════════════════════════════════════════════════

describe('host write rehydration (spike gap 4)', () => {
  it('setDoc: both marker families store as REAL timestamps (rules `is timestamp` passes)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'events/pyric-marker',
      data: { when: pyricMarker(100, 0), label: 'a' },
    }));
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'events/fb-marker',
      data: { when: fbMarker(200, 0), label: 'b' },
    }));

    // Sanity: the rule actually bites — a non-timestamp `when` is denied.
    const denied = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'events/bogus',
      data: { when: 'not-a-timestamp' },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('permission-denied');

    // Read back: the wire read path rehydrates to the marker shape (proves
    // the stored value round-trips as a timestamp, not a doubly-nested map).
    const got = okValue<{ exists: boolean; data?: { json: string } }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'getDoc', path: 'events/pyric-marker' }),
    );
    const data = JSON.parse(got.data!.json) as { when: Record<string, unknown> };
    expectTimestampMarker(data.when, 100);
  });

  it('updateDoc / addDoc rehydrate marker payloads', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'events/u1',
      data: { when: pyricMarker(10, 0) },
    }));
    // update with a marker: the `is timestamp` update rule must still pass.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'updateDoc', path: 'events/u1',
      data: { when: fbMarker(20, 0) },
    }));
    // addDoc under the create rule.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'addDoc', collectionPath: 'events',
      data: { when: pyricMarker(30, 0) },
    }));
  });

  it('batchCommit and txnCommit writes rehydrate marker payloads', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'batchCommit',
      writes: [
        { method: 'set', path: 'events/b1', data: { when: pyricMarker(40, 0) } },
        { method: 'set', path: 'events/b2', data: { when: fbMarker(50, 0) } },
      ],
    }));
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'txnCommit',
      reads: [],
      writes: [
        { method: 'set', path: 'events/t1', data: { when: pyricMarker(60, 0) } },
        { method: 'update', path: 'events/b1', data: { when: fbMarker(70, 0) } },
      ],
    }));
  });

  it('orderBy over relayed timestamps is CHRONOLOGICAL (map ordering would differ)', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    // Chosen so plain-map ordering (key-sorted entries: nanos compared before
    // seconds) would yield late < early — the opposite of timestamp order.
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'free/early',
      data: { when: pyricMarker(100, 900_000) },
    }));
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'free/late',
      data: { when: fbMarker(200, 100) },
    }));

    const res = okValue<{ docs: Array<{ id: string }> }>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs',
      source: {
        __ref: 'query',
        source: { __ref: 'collection', path: 'free' },
        constraints: [{ kind: 'orderBy', field: 'when', direction: 'asc' }],
      },
    }));
    expect(res.docs.map((d) => d.id)).toEqual(['early', 'late']);
  });

  it('sentinels still resolve, including markers nested in arrayUnion values', async () => {
    const ctx = await makeCtx();
    const port = fakePort();

    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: 'free/sentinels',
      data: {
        at: { __sentinel: 'serverTimestamp' },
        n: { __sentinel: 'increment', n: 2 },
        stamps: { __sentinel: 'arrayUnion', values: [pyricMarker(5, 0)] },
        when: pyricMarker(1, 0),
      },
    }));

    const got = okValue<{ exists: boolean; data?: { json: string } }>(
      await sendOp(ctx, port, { t: 'op', id: id(), method: 'getDoc', path: 'free/sentinels' }),
    );
    const data = JSON.parse(got.data!.json) as {
      at: Record<string, unknown>;
      n: number;
      stamps: Array<Record<string, unknown>>;
      when: Record<string, unknown>;
    };
    expectTimestampMarker(data.at); // serverTimestamp resolved
    expect(data.n).toBe(2); // increment applied
    expect(data.stamps).toHaveLength(1);
    expectTimestampMarker(data.stamps[0], 5); // marker inside arrayUnion rehydrated
    expectTimestampMarker(data.when, 1);
  });
});
