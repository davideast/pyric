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
import { installServedStorageRules } from '../../../../src/serve/storage-rules-install.js';
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

const CREATE_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow create: if request.auth != null;
      allow update: if false;
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

  it('keeps the rule an unevaluated deny evaluated with the data missing, and no trace', async () => {
    const ctx = ctxWithFirestoreRules(PUBLIC_DOCS);
    const event = await observedEvent(ctx, getDoc(OK));
    expect(event).toMatchObject({
      production: {
        local: { result: 'unevaluated', needs: ['stored-document'], rule: { line: 5, expression: 'resource.data.public == true' } },
      },
    });
    expect(event).not.toHaveProperty('production.local.trace');
    expect(event).not.toHaveProperty('production.local.drift');
  });

  it('names no rule on a setDoc whose create and update disagree', async () => {
    const ctx = ctxWithFirestoreRules(CREATE_ONLY);
    const setDoc: ObservedCall = { service: 'firestore', method: 'setDoc', path: 'rooms/r1', at: 1, outcome: OK, account: { uid: 'alice' } };
    const event = await observedEvent(ctx, setDoc);
    expect(event).toMatchObject({ production: { local: { result: 'unevaluated', needs: ['stored-document'] } } });
    expect(event).not.toHaveProperty('production.local.rule');
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

const INVITEE_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if resource.data.inviteeEmail == request.auth.token.email;
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

  it('evaluates and preserves the account email in the trace, and evaluates anonymous calls without email', async () => {
    const ctx = ctxWithFirestoreRules(EMAIL_OWNER);
    const call = { ...getDoc(DENIED), account: { uid: 'alice', claims: { email: 'alice@example.com' } } };
    const event = await observedEvent(ctx, call);
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          trace: {
            rules: [{
              checks: expect.arrayContaining([
                expect.objectContaining({ expression: 'request.auth.token.email', state: 'value', value: 'alice@example.com' }),
              ]),
            }],
          },
        },
      },
    });

    const anon = { ...getDoc(DENIED), account: { uid: 'anon-1', claimNames: ['sub'], claims: { sub: 'anon-1' } } };
    expect(await observedEvent(ctx, anon)).toMatchObject({
      production: { local: { result: 'deny' } },
    });

    const signedOutFs = await observedEvent(ctx, { ...getDoc(OK), account: undefined });
    expect(signedOutFs).toMatchObject({
      production: { local: { result: 'deny', drift: true } },
    });
  });

  it('preserves an email address from a returned document in the trace', async () => {
    const ctx = ctxWithFirestoreRules(INVITEE_ONLY);
    const call = { ...getDoc(DENIED), account: { uid: 'alice', claims: { email: 'alice@example.com' } }, document: { inviteeEmail: 'bob@example.com' } };
    const event = await observedEvent(ctx, call);
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          trace: {
            rules: [{
              checks: expect.arrayContaining([
                expect.objectContaining({ expression: 'resource.data.inviteeEmail', state: 'value', value: 'bob@example.com' }),
                expect.objectContaining({ expression: 'request.auth.token.email', state: 'value', value: 'alice@example.com' }),
              ]),
            }],
          },
        },
      },
    });
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
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
          rule: { line: 5, expression: 'resource.data.public == true' },
        },
      },
    });
    expect(event).not.toHaveProperty('production.local.trace');
  });
});

describe('host: RTDB local evaluation trace, listeners, and unevaluated context', () => {
  function rtdbCall(overrides: Partial<ObservedCall> = {}): ObservedCall {
    return {
      service: 'rtdb',
      method: 'get',
      path: '/rooms/s1',
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      at: 1_700_000_000_000,
      outcome: OK,
      account: { uid: 'alice' },
      ...overrides,
    };
  }

  function ctxWithRtdbRules(rules: Record<string, unknown>): HostCtx {
    const ctx = hostCtx();
    expect(setDatabaseRules(ctx, undefined, rules).ok).toBe(true);
    return ctx;
  }

  it('records rtdbTrace, matchedPath, matchedRule, and $variable bindings on RTDB allow and deny', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        '.read': 'false',
        rooms: {
          '.read': 'auth.token.admin === true',
          $roomId: {
            '.read': 'auth != null && $roomId === "s1"',
          },
        },
      },
    });

    const allowed = await observedEvent(ctx, rtdbCall({ account: { uid: 'alice', claims: { admin: false } } }));
    expect(allowed).toMatchObject({
      production: {
        local: {
          result: 'allow',
          rule: { path: '/rooms/$roomId', expression: 'auth != null && $roomId === "s1"' },
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: 'auth != null && $roomId === "s1"',
            pathVariableBindings: { $roomId: 's1' },
            reason: 'Rule expression evaluated to true',
            rtdbTrace: [
              { path: '/', kind: 'read', verdict: 'DENY', conditionText: 'false' },
              { path: '/rooms', kind: 'read', verdict: 'DENY', conditionText: 'auth.token.admin === true' },
              {
                path: '/rooms/$roomId',
                kind: 'read',
                verdict: 'ALLOW',
                conditionText: 'auth != null && $roomId === "s1"',
                pathVariableBindings: { $roomId: 's1' },
              },
            ],
          },
        },
      },
    });

    const denied = await observedEvent(
      ctx,
      rtdbCall({ path: '/rooms/s2', outcome: DENIED, account: { uid: 'alice', claims: { admin: false } } }),
    );
    expect(denied).toMatchObject({
      production: {
        local: {
          result: 'deny',
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: 'auth != null && $roomId === "s1"',
            pathVariableBindings: { $roomId: 's2' },
            rtdbTrace: expect.arrayContaining([
              expect.objectContaining({ path: '/rooms/$roomId', verdict: 'DENY' }),
            ]),
          },
        },
      },
    });
  });

  it('stamps NO_MATCHING_RULE on an implicit RTDB deny', async () => {
    const ctx = ctxWithRtdbRules({ rules: { public: { '.read': 'true' } } });
    const event = await observedEvent(ctx, rtdbCall({ path: '/private/item', outcome: DENIED }));
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          rtdb: {
            matchedPath: '',
            matchedRule: '',
            errorCode: 'NO_MATCHING_RULE',
            rtdbTrace: [],
          },
        },
      },
    });
  });

  it('evaluates RTDB listener deliveries and cancels (onValue and onChild*) as reads', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        rooms: {
          $roomId: {
            '.read': 'auth != null',
          },
        },
      },
    });

    for (const method of ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved'] as const) {
      const allowed = await observedEvent(ctx, rtdbCall({ method }));
      expect(allowed, method).toMatchObject({
        production: {
          local: {
            result: 'allow',
            rtdb: {
              matchedPath: '/rooms/$roomId',
              matchedRule: 'auth != null',
              pathVariableBindings: { $roomId: 's1' },
            },
          },
        },
      });
    }

    const driftingListener = await observedEvent(
      ctx,
      rtdbCall({ method: 'onValue', account: undefined, outcome: OK }),
    );
    expect(driftingListener).toMatchObject({
      production: {
        local: {
          result: 'deny',
          drift: true,
          rtdb: { matchedPath: '/rooms/$roomId', matchedRule: 'auth != null' },
        },
      },
    });

    const claimRuleCtx = ctxWithRtdbRules({
      rules: {
        rooms: {
          $roomId: {
            '.read': "auth != null && auth.token.role === 'admin'",
          },
        },
      },
    });
    const signedOutClaimRead = await observedEvent(
      claimRuleCtx,
      rtdbCall({ account: undefined, outcome: OK }),
    );
    expect(signedOutClaimRead).toMatchObject({
      production: {
        local: {
          result: 'deny',
          drift: true,
        },
      },
    });
  });

  it('evaluates RTDB remove as a delete write with null newData', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        rooms: {
          $roomId: {
            '.write': 'auth.uid === $roomId',
          },
        },
      },
    });
    const removed = await observedEvent(
      ctx,
      rtdbCall({ method: 'remove', path: '/rooms/alice', account: { uid: 'alice' } }),
    );
    expect(removed).toMatchObject({
      production: {
        local: {
          result: 'allow',
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: 'auth.uid === $roomId',
            pathVariableBindings: { $roomId: 'alice' },
          },
        },
      },
    });
  });

  it('preserves applicable rule node and bindings without simulated trace on unevaluated RTDB reads and writes', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        rooms: {
          $roomId: {
            '.read': "root.child('roomMembers/' + $roomId + '/' + auth.uid).exists()",
            '.write': "auth != null && !data.exists() && newData.hasChild('title')",
          },
        },
        queries: {
          '.read': "query.orderByChild === 'owner'",
        },
      },
    });

    const dataRead = await observedEvent(ctx, rtdbCall({ path: '/rooms/s9' }));
    expect(dataRead).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
          rule: {
            path: '/rooms/$roomId',
            expression: "root.child('roomMembers/' + $roomId + '/' + auth.uid).exists()",
          },
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: "root.child('roomMembers/' + $roomId + '/' + auth.uid).exists()",
            pathVariableBindings: { $roomId: 's9' },
          },
        },
      },
    });
    expect(dataRead).not.toHaveProperty('production.local.rtdb.rtdbTrace');
    expect(dataRead).not.toHaveProperty('production.local.rtdb.reason');

    const write = await observedEvent(ctx, rtdbCall({ method: 'set', path: '/rooms/s9' }));
    expect(write).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['stored-document', 'write-data'],
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: "auth != null && !data.exists() && newData.hasChild('title')",
            pathVariableBindings: { $roomId: 's9' },
          },
        },
      },
    });
    expect(write).not.toHaveProperty('production.local.rtdb.rtdbTrace');

    const pushed = await observedEvent(ctx, rtdbCall({ method: 'push', path: '/rooms' }));
    expect(pushed).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['stored-document', 'write-data'],
          rtdb: {
            matchedPath: '/rooms/$roomId',
            matchedRule: "auth != null && !data.exists() && newData.hasChild('title')",
          },
        },
      },
    });

    const queried = await observedEvent(ctx, rtdbCall({ method: 'onValue', path: '/queries' }));
    expect(queried).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['query'],
          rtdb: {
            matchedPath: '/queries',
            matchedRule: "query.orderByChild === 'owner'",
          },
        },
      },
    });
  });

  it('drops oversized rtdbTrace past TRACE_LIMIT while keeping rule metadata', async () => {
    let nested: Record<string, unknown> = { '.read': `'${'x'.repeat(900)}' === 'y'` };
    const segments: string[] = [];
    for (let i = 24; i >= 0; i--) {
      const seg = `level_${i}`;
      segments.unshift(seg);
      nested = { '.read': `'${'x'.repeat(900)}' === '${i}'`, [seg]: nested };
    }
    const ctx = ctxWithRtdbRules({ rules: nested });
    const event = await observedEvent(ctx, rtdbCall({ path: `/${segments.join('/')}`, outcome: DENIED }));
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          rtdb: {
            matchedPath: `/${segments.join('/')}`,
          },
        },
      },
    });
    expect(event).not.toHaveProperty('production.local.rtdb.rtdbTrace');
    // Compiling 25 nested rules with long literals takes seconds under a loaded suite.
  }, 30_000);

  it('records no local verdict for Admin SDK RTDB calls, onDisconnect, or runTransaction', async () => {
    const ctx = ctxWithRtdbRules({ rules: { rooms: { '.read': 'true', '.write': 'true' } } });
    const adminGet = await observedEvent(ctx, rtdbCall({ method: 'Query.get', sdk: 'admin', path: '/rooms' }));
    expect(adminGet).not.toHaveProperty('production.local');
    const onDisc = await observedEvent(ctx, rtdbCall({ method: 'onDisconnect.set', path: '/rooms' }));
    expect(onDisc).not.toHaveProperty('production.local');
    const tx = await observedEvent(ctx, rtdbCall({ method: 'runTransaction', path: '/rooms' }));
    expect(tx).not.toHaveProperty('production.local');
  });

  it('preserves account email addresses in RTDB trace and path bindings', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        invites: {
          $email: {
            '.read': "auth != null && auth.token.email === $email",
          },
        },
      },
    });
    const event = await observedEvent(
      ctx,
      rtdbCall({
        path: '/invites/alice@example.com',
        outcome: DENIED,
        account: { uid: 'bob', claims: { email: 'bob@example.com' } },
      }),
    );
    expect(event).toMatchObject({
      production: {
        local: {
          result: 'deny',
          rtdb: {
            matchedPath: '/invites/$email',
            pathVariableBindings: { $email: 'alice@example.com' },
          },
        },
      },
    });
  });

  it('evaluates RTDB set, push, and update writes when bounded writeData is supplied, and reports .validate gaps without writeData', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        messages: {
          $msgId: {
            '.write': 'auth != null',
            '.validate': "newData.hasChildren(['text'])",
            text: {
              '.validate': 'newData.isString() && newData.val().length <= 10',
            },
          },
        },
        counts: {
          '.write': 'auth != null',
          '.validate': 'newData.isNumber()',
        },
        items: {
          $id: {
            '.write': 'auth != null',
            text: {
              '.validate': 'newData.isString() && newData.val().length <= 10',
            },
          },
        },
      },
    });

    const missingWriteValidate = await observedEvent(
      ctx,
      rtdbCall({ method: 'set', path: '/counts', outcome: DENIED }),
    );
    expect(missingWriteValidate).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['write-data'],
        },
      },
    });

    const validPush = await observedEvent(
      ctx,
      rtdbCall({ method: 'push', path: '/messages', writeData: { text: 'hello' } }),
    );
    expect(validPush).toMatchObject({
      production: {
        local: {
          result: 'allow',
          rtdb: {
            matchedPath: '/messages/$msgId',
            matchedRule: 'auth != null',
          },
        },
      },
    });
    expect(JSON.stringify(validPush?.production?.local)).not.toContain('-O_pyric_push');

    const invalidValidate = await observedEvent(
      ctx,
      rtdbCall({
        method: 'set',
        path: '/messages/m1',
        writeData: { text: 'way too long string' },
        outcome: OK,
      }),
    );
    expect(invalidValidate).toMatchObject({
      production: {
        local: {
          result: 'deny',
          drift: true,
        },
      },
    });

    const updateHitsAncestorValidate = await observedEvent(
      ctx,
      rtdbCall({
        method: 'update',
        path: '/messages/m1',
        writeData: { text: 'short' },
      }),
    );
    expect(updateHitsAncestorValidate).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
        },
      },
    });

    const validLeafUpdate = await observedEvent(
      ctx,
      rtdbCall({
        method: 'update',
        path: '/items/i1',
        writeData: { text: 'short' },
      }),
    );
    expect(validLeafUpdate).toMatchObject({
      production: {
        local: {
          result: 'allow',
        },
      },
    });
  });

  it('checks a multi-location update at each location it names, as production does', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        items: { $id: { '.write': 'auth != null' } },
        notes: { $id: { '.write': 'auth.uid === $id' } },
      },
    });

    const nestedKey = await observedEvent(ctx, rtdbCall({ method: 'update', path: '/items', writeData: { 'a/b': 1 } }));
    expect(nestedKey?.production?.local).toMatchObject({ result: 'allow', rtdb: { matchedPath: '/items/$id' } });
    expect(nestedKey?.production?.local).not.toHaveProperty('drift');

    const fanOut = await observedEvent(ctx, rtdbCall({
      method: 'update',
      path: '/',
      writeData: { 'items/i1/title': 'hi', 'notes/alice/body': 'x' },
    }));
    expect(fanOut?.production?.local).toMatchObject({ result: 'allow' });
    expect(fanOut?.production?.local).not.toHaveProperty('drift');

    // One location the rules refuse denies the whole update.
    const oneRefused = await observedEvent(ctx, rtdbCall({
      method: 'update',
      path: '/',
      writeData: { 'items/i1/title': 'hi', 'notes/bob/body': 'x' },
      outcome: DENIED,
    }));
    expect(oneRefused?.production?.local).toMatchObject({ result: 'deny', rtdb: { matchedPath: '/notes/$id', pathVariableBindings: { $id: 'bob' } } });
    expect(oneRefused?.production?.local).not.toHaveProperty('drift');
  });

  it('leaves a set, push or remove unevaluated when a rule above the written location reads the stored siblings', async () => {
    const ctx = ctxWithRtdbRules({
      rules: {
        messages: {
          $m: {
            '.write': 'auth != null',
            '.validate': "newData.hasChildren(['text', 'author'])",
            text: { '.validate': 'newData.isString()' },
          },
        },
        lists: {
          $l: {
            '.write': 'auth != null',
            entries: { $e: { '.validate': "newData.parent().hasChild('owner') || newData.isString()" } },
          },
        },
      },
    });

    const childSet = await observedEvent(ctx, rtdbCall({ method: 'set', path: '/messages/m1/text', writeData: 'hi' }));
    expect(childSet?.production?.local).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });

    const childPush = await observedEvent(ctx, rtdbCall({ method: 'push', path: '/messages/m1/likes', writeData: 'x' }));
    expect(childPush?.production?.local).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });

    const childRemove = await observedEvent(ctx, rtdbCall({ method: 'remove', path: '/messages/m1/text' }));
    expect(childRemove?.production?.local).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });

    const parentRead = await observedEvent(ctx, rtdbCall({ method: 'push', path: '/lists/l1/entries', writeData: 'x' }));
    expect(parentRead?.production?.local).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });

    // The whole record is written, so the validate sees every child it reads.
    const wholeRecord = await observedEvent(ctx, rtdbCall({
      method: 'set',
      path: '/messages/m2',
      writeData: { text: 'hi' },
      outcome: DENIED,
    }));
    expect(wholeRecord?.production?.local).toMatchObject({ result: 'deny' });
    expect(wholeRecord?.production?.local).not.toHaveProperty('drift');
  });

  it('scrubs secret wildcard bindings and opaque tokens in RTDB bindings, traces, and reasons', async () => {
    const opaque44 = 'tok_0123456789abcdef0123456789abcdef01234567';
    const rtdbCtx = ctxWithRtdbRules({
      rules: {
        orgs: {
          $orgId: {
            tokens: {
              $token: { '.read': 'auth != null' },
            },
            items: {
              $id: { '.read': 'auth != null' },
            },
          },
        },
      },
    });

    const rtdbSecretVar = await observedEvent(
      rtdbCtx,
      rtdbCall({
        method: 'get',
        path: `/orgs/org-1/tokens/${opaque44}`,
        outcome: OK,
        account: { uid: 'uid-1' },
      }),
    );
    const rtdbJson = JSON.stringify(rtdbSecretVar?.production?.local);
    expect(rtdbSecretVar?.production?.local).toMatchObject({
      result: 'allow',
      rtdb: {
        pathVariableBindings: {
          $orgId: 'org-1',
          $token: '[redacted]',
        },
      },
    });
    expect(rtdbJson).not.toContain(opaque44);

    const rtdbOpaqueId = await observedEvent(
      rtdbCtx,
      rtdbCall({
        method: 'get',
        path: `/orgs/org-1/items/${opaque44}`,
        outcome: OK,
        account: { uid: 'uid-1' },
      }),
    );
    expect(JSON.stringify(rtdbOpaqueId?.production?.local)).not.toContain(opaque44);

    const rtdbUnmatched = await observedEvent(
      rtdbCtx,
      rtdbCall({
        method: 'get',
        path: `/unmatched/${opaque44}`,
        outcome: DENIED,
        account: { uid: 'uid-1' },
      }),
    );
    expect(JSON.stringify(rtdbUnmatched?.production?.local)).not.toContain(opaque44);
  });
});

describe('Storage local verdict', () => {
  function ctxWithStorageRules(storageRules: string, storageBucketRules?: Record<string, { rules: string }>): HostCtx {
    const ctx = hostCtx();
    installServedStorageRules(ctx.sandbox, {
      storageRules,
      storageBucketRules,
      projectKey: 'demo-project',
    });
    return ctx;
  }

  function storageCall(overrides: Partial<ObservedCall> = {}): ObservedCall {
    return {
      service: 'storage',
      method: 'getDownloadURL',
      bucket: 'demo-project.appspot.com',
      path: 'uploads/a.png',
      projectId: 'demo-project',
      at: 1_700_000_000_000,
      outcome: OK,
      account: { uid: 'alice' },
      ...overrides,
    };
  }

  it('evaluates Storage reads and metadata-checked uploads against local rules and flags drift', async () => {
    const ctx = ctxWithStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{allPaths=**} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && request.resource.size < 100
        && request.resource.contentType.matches('image/.*');
      allow delete: if request.auth != null && resource != null;
    }
  }
}`);

    const readOk = await observedEvent(ctx, storageCall());
    expect(readOk).toMatchObject({
      production: {
        local: {
          result: 'allow',
          rule: { path: 'match /uploads/{allPaths=**}', line: 5 },
          storage: { matchedPath: 'match /uploads/{allPaths=**}', matchedLine: 5 },
        },
      },
    });

    const readDrift = await observedEvent(ctx, storageCall({ account: undefined, outcome: OK }));
    expect(readDrift).toMatchObject({
      production: {
        local: {
          result: 'deny',
          drift: true,
        },
      },
    });

    const uploadOk = await observedEvent(
      ctx,
      storageCall({
        method: 'uploadBytes',
        writeData: { size: 50, contentType: 'image/png' },
      }),
    );
    expect(uploadOk).toMatchObject({
      production: {
        local: {
          result: 'allow',
        },
      },
    });

    const uploadTooBig = await observedEvent(
      ctx,
      storageCall({
        method: 'uploadBytes',
        writeData: { size: 500, contentType: 'image/png' },
        outcome: DENIED,
      }),
    );
    expect(uploadTooBig).toMatchObject({
      production: {
        local: {
          result: 'deny',
        },
      },
    });

    const deleteMissingResource = await observedEvent(ctx, storageCall({ method: 'deleteObject' }));
    expect(deleteMissingResource).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: ['stored-document'],
        },
      },
    });

    const undeployedBucket = await observedEvent(ctx, storageCall({ bucket: 'other-bucket.appspot.com' }));
    expect(undeployedBucket).not.toHaveProperty('production.local');
  });

  it('evaluates Storage getMetadata with document and reports token email / missing writeData gaps honestly', async () => {
    const ctx = ctxWithStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /private/{file} {
      allow get: if resource.metadata.owner == request.auth.uid;
      allow update: if request.auth.token.email == 'alice@example.com' && request.resource.size < 100;
    }
  }
}`);

    const metaAllow = await observedEvent(
      ctx,
      storageCall({
        method: 'getMetadata',
        path: 'private/doc.txt',
        document: { size: 20, customMetadata: { owner: 'alice' }, bucket: 'demo-project.appspot.com', fullPath: 'private/doc.txt' },
      }),
    );
    expect(metaAllow).toMatchObject({
      production: {
        local: { result: 'allow' },
      },
    });

    const updateGap = await observedEvent(
      ctx,
      storageCall({
        method: 'updateMetadata',
        path: 'private/doc.txt',
        writeData: { contentType: 'text/plain' },
        account: { uid: 'alice', claimNames: ['email'], claims: {} },
      }),
    );
    expect(updateGap).toMatchObject({
      production: {
        local: {
          result: 'unevaluated',
          needs: expect.arrayContaining(['claim-values']),
        },
      },
    });
  });

  it('forwards captured HTTP header fields on stored objects and abstains on uncaptured md5Hash, crc32c, and etag', async () => {
    const ctx = ctxWithStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function matchesCrc(res) {
      let sum = res['crc32c'];
      return sum != '';
    }
    match /items/{id} {
      allow read: if resource.cacheControl == 'public, max-age=3600'
                  && resource.contentDisposition == 'inline'
                  && resource.contentEncoding == 'identity'
                  && resource.contentLanguage == 'en';
      allow read: if resource.etag != '';
    }
    match /docs/{docId} {
      allow read: if resource.md5Hash != '';
    }
    match /archives/{id} {
      allow read: if matchesCrc(resource);
    }
    match /tagged/{id} {
      allow read: if 'etag' in resource && resource.get('etag', '') != '';
    }
  }
}`);

    const baseStored = {
      bucket: 'demo-project.appspot.com',
      size: 128,
      contentType: 'text/plain',
      cacheControl: 'public, max-age=3600',
      contentDisposition: 'inline',
      contentEncoding: 'identity',
      contentLanguage: 'en',
      timeCreated: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      generation: '1',
      metageneration: '1',
    };

    // Captured HTTP header metadata evaluates deterministically as allow, even when a later unreached rule mentions `resource.etag`
    // and sibling match blocks read `resource.md5Hash`.
    const headersAllowed = await observedEvent(
      ctx,
      storageCall({
        method: 'getMetadata',
        path: 'items/item-1',
        document: { ...baseStored, fullPath: 'items/item-1' },
      }),
    );
    expect(headersAllowed?.production?.local).toMatchObject({ result: 'allow' });
    expect(headersAllowed?.production?.local).not.toHaveProperty('drift');

    // Uncaptured `md5Hash`, `crc32c` (via helper + let + bracket), and `etag` (via `in` / `.get()`) abstain on `stored-document`.
    for (const targetPath of ['docs/doc-1', 'archives/a-1', 'tagged/t-1']) {
      const abstained = await observedEvent(
        ctx,
        storageCall({
          method: 'getMetadata',
          path: targetPath,
          document: { ...baseStored, fullPath: targetPath },
        }),
      );
      expect(abstained?.production?.local).toEqual(
        expect.objectContaining({
          result: 'unevaluated',
          needs: ['stored-document'],
        }),
      );
    }
  });

  it('abstains with claim-values when Storage rules read redacted email via firebase.identities, token.get, or token.keys', async () => {
    const ctx = ctxWithStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid} {
      allow read: if request.auth != null && 'email' in request.auth.token.firebase.identities;
    }
    match /items/{id} {
      allow read: if request.auth != null && request.auth.token.get('email', '') == 'member@example.com';
    }
    match /docs/{docId} {
      allow read: if request.auth != null && 'email' in request.auth.token.keys();
    }
  }
}`);

    const emailRedactedAccount = {
      uid: 'u-1',
      claimNames: ['email', 'firebase'],
      claims: {
        email_verified: true,
        firebase: {
          sign_in_provider: 'password',
          identities: {},
        },
      },
    };

    for (const targetPath of ['users/u-1', 'items/item-1', 'docs/doc-1']) {
      const ev = await observedEvent(
        ctx,
        storageCall({
          method: 'getBytes',
          path: targetPath,
          account: emailRedactedAccount,
        }),
      );
      expect(ev?.production?.local).toMatchObject({
        result: 'unevaluated',
        needs: ['claim-values'],
      });
    }
  });

  it('scrubs secret field/claim values, helper bindings, and token strings from Firestore traces, RTDB bindings/reasons, and Storage reasons', async () => {
    const dummyJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJ1c2VyLTEiLCJlbWFpbCI6InVzZXJAZXhhbXBsZS50ZXN0In0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const apiKey39 = ['AIza', 'SyDummyKey0123456789abcdef012345678'].join('');
    const opaque44 = 'tok_0123456789abcdef0123456789abcdef01234567';
    const oauthToken = ['ya29', '.a0DummyOAuth0123456789abcdef'].join('');
    const refreshToken = ['1//', '0gDummyRefreshToken0123456789abcdef'].join('');

    const fsCtx = ctxWithFirestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function matchesSecret(val) {
      let localCopy = val;
      return localCopy == 'expected';
    }
    match /items/{id} {
      allow read: if resource.data.apiKey == 'expected'
                  || request.auth.token.secretClaim == 'expected'
                  || resource.data['password'] == 'expected'
                  || resource.data.get('firebaseStorageDownloadTokens', '') == 'expected'
                  || request.auth.token.token == 'expected'
                  || matchesSecret(resource.data.clientSecret)
                  || resource.data.note == 'expected';
    }
  }
}`);

    const fsEvent = await observedEvent(fsCtx, {
      service: 'firestore',
      method: 'getDoc',
      path: 'items/item-1',
      at: 1,
      outcome: DENIED,
      account: {
        uid: 'uid-1',
        claimNames: ['secretClaim', 'token', 'email'],
        claims: {
          secretClaim: dummyJwt,
          token: 'short-custom-token-claim',
          email: 'alice@example.com',
        },
      },
      document: {
        apiKey: apiKey39,
        password: 'short-password-value',
        firebaseStorageDownloadTokens: '9f8e7d6c-5b4a-4321-8765-abcdef012345',
        clientSecret: 'short-helper-secret',
        note: `oauth=${oauthToken} refresh=${refreshToken} opaque=${opaque44}`,
      },
    });

    const fsJson = JSON.stringify(fsEvent?.production?.local);
    expect(fsEvent?.production?.local?.result).toBe('deny');
    expect(fsJson).not.toContain(dummyJwt);
    expect(fsJson).not.toContain(apiKey39);
    expect(fsJson).not.toContain('short-password-value');
    expect(fsJson).not.toContain('9f8e7d6c-5b4a-4321-8765-abcdef012345');
    expect(fsJson).not.toContain('short-custom-token-claim');
    expect(fsJson).not.toContain('short-helper-secret');
    expect(fsJson).not.toContain(oauthToken);
    expect(fsJson).not.toContain(refreshToken);
    expect(fsJson).not.toContain(opaque44);

    const storageCtx = ctxWithStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if false;
    }
  }
}`);
    const stEvent = await observedEvent(
      storageCtx,
      storageCall({
        method: 'getBytes',
        path: `docs/${opaque44}`,
        outcome: { status: 'error', code: 'storage/unauthorized' },
      }),
    );
    expect(JSON.stringify(stEvent?.production?.local)).not.toContain(opaque44);
  });
});
