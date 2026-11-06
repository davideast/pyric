/**
 * A live host evaluates each observed Firestore and RTDB call against the
 * local rules files the sandbox loaded, and records that verdict beside
 * production's. Production decided the call, so the event's result and Rules
 * disposition stay production's; the local verdict is `production.local`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type ObservedCall, type SandboxEvent } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { deployFirestoreRulesToHost, setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';

interface FakePort extends PortLike { messages: OutboundMessage[] }

function fakePort(): FakePort {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(message) { messages.push(message); } };
}

function hostCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'local-verdict-test', subs: new Map(), rtdbProjectId: 'demo-project' };
}

/** A host that loaded `source` as the app's Firestore rules, as a project's rules file loads. */
function ctxWithFirestoreRules(source: string): HostCtx {
  const ctx = hostCtx();
  expect(deployFirestoreRulesToHost(ctx, source).ok).toBe(true);
  return ctx;
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

const OWNER_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner() { return resource.data.owner == request.auth.uid; }
    match /rooms/{roomId} {
      allow read: if isOwner();
    }
  }
}`;

const OWN_PROFILE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
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

const ADMIN_CLAIM = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if request.auth.token.admin == true;
    }
  }
}`;

const OWNED_WRITES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow create: if request.resource.data.owner == request.auth.uid;
      allow update: if request.resource.data.owner == request.auth.uid;
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

  it('leaves a call unevaluated when a helper function reads the stored document', async () => {
    const ctx = ctxWithFirestoreRules(OWNER_ONLY);
    const event = await observedEvent(ctx, getDoc(OK));
    expect(event).toMatchObject({ production: { outcome: OK, local: { result: 'unevaluated', needs: ['stored-document'] } } });
  });

  it('gives a setDoc a verdict when its create and its update agree', async () => {
    const ctx = ctxWithFirestoreRules(OWN_PROFILE);
    const setDoc: ObservedCall = { service: 'firestore', method: 'setDoc', path: 'users/alice', at: 1, outcome: OK, account: { uid: 'alice' } };
    const event = await observedEvent(ctx, setDoc);
    expect(event).toMatchObject({ production: { local: { result: 'allow', rule: { line: 5 } } } });
    expect(event).not.toHaveProperty('production.local.drift');
  });

  it('records no Firestore verdict when the app loaded no rules file', async () => {
    const event = await observedEvent(hostCtx(), getDoc(DENIED));
    expect(event).toMatchObject({ result: 'deny', production: { outcome: DENIED } });
    expect(event).not.toHaveProperty('production.local');
  });

  it('records no Firestore verdict when the app rules file did not parse', async () => {
    const ctx = hostCtx();
    expect(deployFirestoreRulesToHost(ctx, 'service cloud.firestore {').ok).toBe(false);
    const event = await observedEvent(ctx, getDoc(DENIED));
    expect(event).not.toHaveProperty('production.local');
  });

  it('records no RTDB verdict for an instance with no local rules', async () => {
    const read: ObservedCall = {
      service: 'rtdb', method: 'get', path: '/items/a', instance: 'demo-project-named', projectId: 'demo-project', at: 1, outcome: DENIED, account: { uid: 'alice' },
    };
    const event = await observedEvent(hostCtx(), read);
    expect(event).not.toHaveProperty('production.local');
  });

  it('evaluates an RTDB call against the instance rules and flags drift', async () => {
    const ctx = hostCtx();
    expect(setDatabaseRules(ctx, undefined, { rules: { items: { '.read': 'auth != null' } } }).ok).toBe(true);
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

  it('evaluates a rule that reads a claim with the claim values the call carries', async () => {
    const ctx = ctxWithFirestoreRules(ADMIN_CLAIM);
    const admin = { ...getDoc(OK), account: { uid: 'alice', claimNames: ['admin'], claims: { admin: true } } };
    expect(await observedEvent(ctx, admin)).toMatchObject({ production: { local: { result: 'allow', rule: { line: 5 } } } });
    const member = { ...getDoc(DENIED), account: { uid: 'bob', claims: { admin: false } } };
    const denied = await observedEvent(ctx, member);
    expect(denied).toMatchObject({ production: { local: { result: 'deny' } } });
    expect(denied).not.toHaveProperty('production.local.drift');
  });

  it('leaves a claim rule unevaluated when the call carries no claim values', async () => {
    const ctx = ctxWithFirestoreRules(ADMIN_CLAIM);
    const event = await observedEvent(ctx, { ...getDoc(OK), account: { uid: 'alice', claimNames: ['admin'] } });
    expect(event).toMatchObject({ production: { local: { result: 'unevaluated', needs: ['claim-values'] } } });
  });

  it('evaluates a rule that reads the stored document with the document the read returned', async () => {
    const ctx = ctxWithFirestoreRules(PUBLIC_DOCS);
    const event = await observedEvent(ctx, { ...getDoc(OK), document: { public: true } });
    expect(event).toMatchObject({ production: { local: { result: 'allow', rule: { line: 5 } } } });
    expect(event).not.toHaveProperty('production.local.drift');
  });

  it('evaluates a create with the data the call wrote, and flags drift on a mismatch', async () => {
    const ctx = ctxWithFirestoreRules(OWNED_WRITES);
    const add: ObservedCall = { service: 'firestore', method: 'addDoc', path: 'rooms/r9', at: 1, outcome: OK, account: { uid: 'alice' }, writeData: { owner: 'alice' } };
    expect(await observedEvent(ctx, add)).toMatchObject({ production: { local: { result: 'allow', rule: { line: 5 } } } });
    const other = await observedEvent(ctx, { ...add, writeData: { owner: 'bob' } });
    expect(other).toMatchObject({ production: { local: { result: 'deny', drift: true } } });
  });

  it('gives a setDoc a verdict from the data it wrote', async () => {
    const ctx = ctxWithFirestoreRules(OWNED_WRITES);
    const set: ObservedCall = { service: 'firestore', method: 'setDoc', path: 'rooms/r1', at: 1, outcome: OK, account: { uid: 'alice' }, writeData: { owner: 'alice' } };
    expect(await observedEvent(ctx, set)).toMatchObject({ production: { local: { result: 'allow' } } });
  });

  it('leaves a write rule unevaluated without write data, and an update without the stored document', async () => {
    const ctx = ctxWithFirestoreRules(OWNED_WRITES);
    const add: ObservedCall = { service: 'firestore', method: 'addDoc', path: 'rooms/r9', at: 1, outcome: OK, account: { uid: 'alice' } };
    expect(await observedEvent(ctx, add)).toMatchObject({ production: { local: { result: 'unevaluated', needs: ['write-data'] } } });
    const update: ObservedCall = { ...add, method: 'updateDoc', path: 'rooms/r1', writeData: { title: 'x' } };
    expect(await observedEvent(ctx, update)).toMatchObject({ production: { local: { result: 'unevaluated', needs: ['stored-document'] } } });
  });

  it('evaluates an RTDB rule that reads a claim with the claim values the call carries', async () => {
    const ctx = hostCtx();
    expect(setDatabaseRules(ctx, undefined, { rules: { items: { '.read': 'auth.token.admin === true' } } }).ok).toBe(true);
    const read: ObservedCall = {
      service: 'rtdb', method: 'get', path: '/items/a', instance: 'demo-project-default-rtdb', projectId: 'demo-project', at: 1, outcome: OK,
      account: { uid: 'alice', claims: { admin: true } },
    };
    expect(await observedEvent(ctx, read)).toMatchObject({ production: { local: { result: 'allow' } } });
  });

  it('records no local verdict for a call the rules do not govern', async () => {
    const ctx = ctxWithFirestoreRules(SIGNED_IN);
    const event = await observedEvent(ctx, { service: 'auth', method: 'signInAnonymously', at: 1, outcome: OK, account: { uid: 'alice' } });
    expect(event).not.toHaveProperty('production.local');
  });
});

const EMAIL_OWNER = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if request.auth.token.email == 'owner@example.com';
    }
  }
}`;

/** A create rule that compares `fields` long written strings, so its trace passes the size cap. */
function longChecks(fields: number): string {
  const checks = Array.from({ length: fields }, (_, index) => `request.resource.data.f${index} == request.resource.data.f${index}`);
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow create: if ${checks.join(' && ')};
    }
  }
}`;
}

interface TracedEvent { production: { local: { trace: { version: unknown; rules: Array<{ checks: unknown[] }> } } } }

describe('host: the local evaluation trace of an observed call', () => {
  it('keeps the trace a sandbox request carries on an allow', async () => {
    const ctx = ctxWithFirestoreRules(SIGNED_IN);
    const event = await observedEvent(ctx, getDoc(OK));
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'allow',
          trace: {
            scope: 'request',
            decision: 'ALLOW',
            truncated: false,
            rules: [{ expression: 'request.auth != null', verdict: 'ALLOW', line: 5 }],
            paths: expect.arrayContaining([expect.objectContaining({ matched: true })]),
          },
        },
      },
    });
    const trace = (event as unknown as TracedEvent).production.local.trace;
    expect(typeof trace.version).toBe('string');
    expect(trace.rules[0]!.checks.length).toBeGreaterThan(0);
  });

  it('keeps the checks and their values on a deny', async () => {
    const ctx = ctxWithFirestoreRules(ADMIN_ONLY);
    const event = await observedEvent(ctx, getDoc(DENIED));
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          trace: {
            decision: 'DENY',
            rules: [{
              expression: "request.auth.uid == 'admin'",
              verdict: 'DENY',
              checks: expect.arrayContaining([expect.objectContaining({ expression: 'request.auth.uid', state: 'value', value: 'alice' })]),
            }],
          },
        },
      },
    });
  });

  it('keeps the account email out of the trace', async () => {
    const ctx = ctxWithFirestoreRules(EMAIL_OWNER);
    const call = { ...getDoc(DENIED), account: { uid: 'alice', claims: { email: 'alice@example.com' } } };
    const event = await observedEvent(ctx, call);
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          trace: { rules: [{ checks: expect.arrayContaining([expect.objectContaining({ expression: 'request.auth.token.email', state: 'unavailable' })]) }] },
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain('alice@example.com');
  });

  it('drops a trace past the size cap and keeps the verdict', async () => {
    const fields = 40;
    const ctx = ctxWithFirestoreRules(longChecks(fields));
    const writeData = Object.fromEntries(Array.from({ length: fields }, (_, index) => [`f${index}`, 'x'.repeat(250)]));
    const add: ObservedCall = { service: 'firestore', method: 'addDoc', path: 'rooms/r9', at: 1, outcome: OK, account: { uid: 'alice' }, writeData };
    const event = await observedEvent(ctx, add);
    expect(event).toMatchObject({ production: { local: { result: 'allow', rule: { line: 5 } } } });
    expect(event).not.toHaveProperty('production.local.trace');
  });

  it('keeps no trace on an unevaluated verdict', async () => {
    const ctx = ctxWithFirestoreRules(PUBLIC_DOCS);
    const event = await observedEvent(ctx, getDoc(DENIED));
    expect(event).toMatchObject({ production: { local: { result: 'unevaluated' } } });
    expect(event).not.toHaveProperty('production.local.trace');
  });
});
