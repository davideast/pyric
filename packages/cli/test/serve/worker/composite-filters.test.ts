/**
 * Composite `and`/`or` filter descriptors (remote sandbox slice 2; spike
 * gap 1).
 *
 * The query descriptor model gains a nesting FILTER union
 * (`FilterConstraintDescriptor`: where | and | or) so `or()`/`and()` queries
 * cross the wire: the client factories emit plain descriptors, the host
 * rebuilds them through the REAL `pyric/firestore` `and`/`or` factories.
 * Frames are JSON-round-tripped (the WS legs). Covers flat composites,
 * nesting both ways, composites alongside orderBy/limit, `count` over a
 * composite source, and the invalid-operand / empty-composite errors —
 * both host-side (malformed wire) and client-factory-side (TypeError at
 * build time, mirroring the modular SDK).
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
  TargetDescriptor,
  FilterConstraintDescriptor,
  QueryConstraintDescriptor,
} from '../../../src/serve/worker/protocol.js';
import { where, and, or, orderBy } from '../../../src/serve/worker/client.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

// ─── Harness ────────────────────────────────────────────────────────────────

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(msg: OutboundMessage) { messages.push(msg); } };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'composite-filters-test', subs: new Map() };
}

function tick(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }

let _seq = 0;
function id(): string { return `comp-op-${++_seq}`; }

function overWire<T>(frame: T): T { return JSON.parse(JSON.stringify(frame)) as T; }

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

/** Build a query TargetDescriptor over /items with the given constraints. */
function itemsQuery(...constraints: QueryConstraintDescriptor[]): TargetDescriptor {
  return { __ref: 'query', source: { __ref: 'collection', path: 'items' }, constraints };
}

async function seedItems(ctx: HostCtx, port: FakePort): Promise<void> {
  const docs: Array<[string, Record<string, unknown>]> = [
    ['a', { cat: 'x', n: 1 }],
    ['b', { cat: 'x', n: 5 }],
    ['c', { cat: 'y', n: 5 }],
    ['d', { cat: 'z', n: 9 }],
  ];
  for (const [docId, data] of docs) {
    okValue(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'setDoc', path: `items/${docId}`, data,
    }));
  }
}

async function queryIds(
  ctx: HostCtx,
  port: FakePort,
  ...constraints: QueryConstraintDescriptor[]
): Promise<string[]> {
  const res = okValue<{ docs: Array<{ id: string }> }>(await sendOp(ctx, port, {
    t: 'op', id: id(), method: 'getDocs', source: itemsQuery(...constraints),
  }));
  return res.docs.map((d) => d.id).sort();
}

// Descriptor shorthands (the wire shapes the client factories emit).
const W = (field: string, op: string, value: unknown): FilterConstraintDescriptor =>
  ({ kind: 'where', field, op, value });
const AND = (...filters: FilterConstraintDescriptor[]): FilterConstraintDescriptor =>
  ({ kind: 'and', filters });
const OR = (...filters: FilterConstraintDescriptor[]): FilterConstraintDescriptor =>
  ({ kind: 'or', filters });

// ════════════════════════════════════════════════════════════════════════════

describe('composite filter descriptors — host', () => {
  it('flat or / and composites', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    expect(await queryIds(ctx, port, OR(W('cat', '==', 'x'), W('cat', '==', 'y'))))
      .toEqual(['a', 'b', 'c']);
    expect(await queryIds(ctx, port, AND(W('cat', '==', 'x'), W('n', '>=', 5))))
      .toEqual(['b']);
  });

  it('nested compositions both ways', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    // or(and(cat==x, n>=5), cat==z) → b, d
    expect(await queryIds(ctx, port, OR(AND(W('cat', '==', 'x'), W('n', '>=', 5)), W('cat', '==', 'z'))))
      .toEqual(['b', 'd']);
    // and(or(cat==x, cat==y), n==5) → b, c
    expect(await queryIds(ctx, port, AND(OR(W('cat', '==', 'x'), W('cat', '==', 'y')), W('n', '==', 5))))
      .toEqual(['b', 'c']);
    // three levels: or(and(or(cat==x, cat==y), n==5), cat==z) → b, c, d
    expect(await queryIds(ctx, port,
      OR(AND(OR(W('cat', '==', 'x'), W('cat', '==', 'y')), W('n', '==', 5)), W('cat', '==', 'z'))))
      .toEqual(['b', 'c', 'd']);
  });

  it('composites compose with orderBy/limit, and count works over them', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    const res = okValue<{ docs: Array<{ id: string }> }>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs',
      source: itemsQuery(
        OR(W('cat', '==', 'x'), W('cat', '==', 'y')),
        { kind: 'orderBy', field: 'n', direction: 'desc' },
        { kind: 'limit', n: 2 },
      ),
    }));
    // n=5 tie between b and c breaks on the implicit key ordering, which
    // follows the last orderBy's DESC direction — so c precedes b.
    expect(res.docs.map((d) => d.id)).toEqual(['c', 'b']);

    const count = okValue<{ count: number }>(await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'count',
      source: itemsQuery(OR(W('cat', '==', 'x'), W('cat', '==', 'z'))),
    }));
    expect(count.count).toBe(3);
  });

  it('malformed composites surface as error responses, not crashes', async () => {
    const ctx = await makeCtx();
    const port = fakePort();
    await seedItems(ctx, port);

    // Empty composite — modular factory TypeError, relayed as an error res.
    const empty = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs',
      source: itemsQuery({ kind: 'or', filters: [] }),
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toContain('at least one filter');

    // Non-filter nested inside a composite (malformed wire input).
    const nonFilter = await sendOp(ctx, port, {
      t: 'op', id: id(), method: 'getDocs',
      source: itemsQuery({
        kind: 'and',
        filters: [{ kind: 'orderBy', field: 'n' } as unknown as FilterConstraintDescriptor],
      }),
    });
    expect(nonFilter.ok).toBe(false);
    if (!nonFilter.ok) expect(nonFilter.error.message).toContain('non-filter');
  });
});

describe('composite filter factories — client', () => {
  it('emit nested descriptors matching the wire shape', () => {
    const built = or(and(where('cat', '==', 'x'), where('n', '>=', 5)), where('cat', '==', 'z'));
    expect(built._descriptor).toEqual(
      OR(AND(W('cat', '==', 'x'), W('n', '>=', 5)), W('cat', '==', 'z')),
    );
  });

  it('reject non-filter operands and empty composites at build time', () => {
    expect(() => and(orderBy('n'))).toThrow(TypeError);
    expect(() => or(where('a', '==', 1), orderBy('n'))).toThrow(/non-filter/);
    expect(() => or()).toThrow(/at least one filter/);
    expect(() => and()).toThrow(TypeError);
  });
});
