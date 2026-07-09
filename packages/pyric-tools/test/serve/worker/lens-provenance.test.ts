/**
 * Auth-lens PROVENANCE stamping at dispatch (worker host).
 *
 * THE BUG THIS PINS: a Studio data-viewer read under `actAs: { mode: 'admin' }`
 * bypassed rules, but the events it emitted carried NO `authLens` — so
 * Traffic's `verdictFor` saw a bare `result: 'allow'` and mislabeled the
 * BYPASS as a rules ALLOW (undefined matched rule, contradictory re-run).
 *
 * FIX UNDER TEST: `handleMessage` wraps dispatch in the sandbox's
 * ambient-provenance window with the op's effective lens (`authLens:
 * msg.actAs`) whenever `actAs` is present — independent of the `issuer`
 * declaration, because admin is admin regardless of who asked (agent tool
 * relays included). Events an emitter already stamped win (stampProvenance:
 * the event's own field beats the ambient default).
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
import {
  initializeSandbox,
  createMemoryBackend,
  type SandboxEvent,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getAuth } from 'pyric/auth';

const DEFAULT_DENY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    messages,
    postMessage(msg: OutboundMessage) { messages.push(msg); },
  };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<{ ctx: HostCtx; events: SandboxEvent[] }> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(DEFAULT_DENY_RULES);
  // Seed a doc through the rules-bypassing admin surface so reads have
  // something to hit despite the default-deny rules.
  sandbox.admin.setDocument('conversations/alice-bob', { topic: 'hi' });
  await sandbox.enablePersistence({
    key: `lens-prov-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  getAuth(sandbox);
  const db = getFirestore(sandbox);
  const events: SandboxEvent[] = [];
  sandbox.onEvent((e) => events.push(e));
  return { ctx: { db, sandbox, subs: new Map(), sessionMode: 'LOCAL' }, events };
}

function tick(ms = 0): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
let _seq = 0;
function id(): string { return `lens-prov-${++_seq}`; }

async function send(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage | undefined> {
  await handleMessage(ctx, port, msg);
  await tick();
  return port.messages.find(
    (m): m is ResMessage => m.t === 'res' && m.id === (msg as { id: string }).id,
  );
}

describe('worker host: authLens provenance stamped at dispatch', () => {
  it('stamps { mode: "admin" } onto the events of an admin-lens op (no issuer)', async () => {
    const { ctx, events } = await makeCtx();
    const port = fakePort();

    // An agent-relay-style op: actAs admin, NO issuer declaration. Under
    // default-deny rules this read succeeds ONLY because of the bypass.
    const res = await send(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: 'conversations/alice-bob',
      actAs: { mode: 'admin' },
    } as InboundMessage);
    expect(res?.ok).toBe(true);

    const opEvents = events.filter((e) => 'authLens' in e && e.authLens);
    expect(opEvents.length).toBeGreaterThan(0);
    for (const e of opEvents) {
      expect(e.authLens).toEqual({ mode: 'admin' });
    }
    // The bug's signature: NO event from this op may claim a bare rules allow.
    const bareAllow = events.find(
      (e) => 'result' in e && e.result === 'allow' && e.authLens?.mode !== 'admin',
    );
    expect(bareAllow).toBeUndefined();
  });

  it('stamps an impersonation lens ({ mode: "as", uid }) the same way', async () => {
    const { ctx, events } = await makeCtx();
    const port = fakePort();

    // Denied under default-deny rules, but the DENY event must still carry
    // the lens it evaluated under.
    await send(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: 'conversations/alice-bob',
      actAs: { mode: 'as', uid: 'bob' },
      issuer: 'studio',
    } as InboundMessage);

    const stamped = events.filter((e) => e.authLens?.mode === 'as');
    expect(stamped.length).toBeGreaterThan(0);
    for (const e of stamped) {
      expect(e.authLens).toEqual({ mode: 'as', uid: 'bob' });
      // Issuer declaration rides alongside, unchanged.
      expect(e.actor).toEqual({ kind: 'studio' });
    }
  });

  it('an op without actAs keeps the app-session default (no admin mislabel)', async () => {
    const { ctx, events } = await makeCtx();
    const port = fakePort();

    await send(ctx, port, {
      t: 'op', id: id(), method: 'getDoc', path: 'conversations/alice-bob',
    } as InboundMessage);

    const admin = events.find((e) => e.authLens?.mode === 'admin');
    expect(admin).toBeUndefined();
  });
});
