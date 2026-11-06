/**
 * A live host evaluates each observed Firestore and RTDB call against the
 * local rules files the sandbox loaded, and records that verdict beside
 * production's. Production decided the call, so the event's result and Rules
 * disposition stay production's; the local verdict is `production.local`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type ObservedCall, type SandboxEvent } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { sandbox as rtdbSandbox } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { rtdbInstance } from '../../../../src/serve/worker/host/rtdb-instances.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';

interface FakePort extends PortLike { messages: OutboundMessage[] }

function fakePort(): FakePort {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(message) { messages.push(message); } };
}

function ctxWithFirestoreRules(source: string): HostCtx {
  const sandbox = initializeSandbox();
  setRules(sandbox, source);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'local-verdict-test', subs: new Map() };
}

let sequence = 0;

/** Observe one call through the host and return the event it wrote. */
async function observedEvent(ctx: HostCtx, call: ObservedCall): Promise<SandboxEvent | undefined> {
  const port = fakePort();
  const id = `observe-${++sequence}`;
  await handleMessage(ctx, port, { t: 'observe', id, call } as InboundMessage);
  const reply = port.messages.find((message) => message.t === 'res' && message.id === id);
  expect(reply).toMatchObject({ ok: true });
  return ctx.sandbox.history().at(-1);
}

const DENIED = { status: 'error', code: 'permission-denied' } as const;
const OK = { status: 'ok' } as const;

function getDoc(outcome: ObservedCall['outcome'], uid = 'alice'): ObservedCall {
  return { service: 'firestore', method: 'getDoc', path: 'rooms/r1', at: 1_700_000_000_000, outcome, account: { uid } };
}

const SIGNED_IN = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if request.auth != null;
    }
  }
}`;

const ADMIN_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if request.auth.uid == 'admin';
    }
  }
}`;

const PUBLIC_DOCS = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if resource.data.public == true;
    }
  }
}`;

describe('host: local verdict of an observed call', () => {
  it('records a live allow the local rules also allow, with the rule that allowed it', async () => {
    const ctx = ctxWithFirestoreRules(SIGNED_IN);
    const event = await observedEvent(ctx, getDoc(OK));
    expect(event).toMatchObject({
      kind: 'operation',
      result: 'allow',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: OK, local: { result: 'allow', rule: { line: 5, expression: 'request.auth != null' } } },
    });
    expect(event).not.toHaveProperty('production.local.drift');
  });

  it('explains a live deny with the local rule that denied it', async () => {
    const ctx = ctxWithFirestoreRules(ADMIN_ONLY);
    const event = await observedEvent(ctx, getDoc(DENIED));
    expect(event).toMatchObject({
      result: 'deny',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: DENIED, local: { result: 'deny', rule: { line: 5 } } },
    });
    expect(event).not.toHaveProperty('production.local.drift');
  });

  it('flags drift when the local rules allow a call production denied', async () => {
    const ctx = ctxWithFirestoreRules(SIGNED_IN);
    const event = await observedEvent(ctx, getDoc(DENIED));
    expect(event).toMatchObject({
      result: 'deny',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: DENIED, local: { result: 'allow', drift: true } },
    });
  });

  it('leaves a call unevaluated when the rules read the stored document', async () => {
    const ctx = ctxWithFirestoreRules(PUBLIC_DOCS);
    const event = await observedEvent(ctx, getDoc(DENIED));
    expect(event).toMatchObject({ production: { local: { result: 'unevaluated', needs: ['stored-document'] } } });
  });

  it('evaluates an RTDB call against the instance rules and flags drift', async () => {
    const ctx = { ...ctxWithFirestoreRules(SIGNED_IN), rtdbProjectId: 'demo-project' };
    rtdbSandbox.setRules(rtdbInstance(ctx).live, { rules: { items: { '.read': 'auth != null' } } });
    const read: ObservedCall = {
      service: 'rtdb',
      method: 'get',
      path: '/items/a',
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      at: 1,
      outcome: DENIED,
      account: { uid: 'alice' },
    };
    const event = await observedEvent(ctx, read);
    expect(event).toMatchObject({
      result: 'deny',
      production: { outcome: DENIED, local: { result: 'allow', drift: true, rule: { path: '/items', expression: 'auth != null' } } },
    });
  });

  it('records no local verdict for a call the rules do not govern', async () => {
    const ctx = ctxWithFirestoreRules(SIGNED_IN);
    const event = await observedEvent(ctx, { service: 'auth', method: 'signInAnonymously', at: 1, outcome: OK, account: { uid: 'alice' } });
    expect(event).not.toHaveProperty('production.local');
  });
});
