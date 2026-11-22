import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import {
  InMemoryIdentityTriggerDelivery,
  RemoteIdentityTriggerDelivery,
} from '../../src/functions/identity/delivery.js';
import { BEFORE_CREATE_EVENT_TYPE } from '../../src/functions/identity/discovery.js';
import { startIdentityTriggerExecution } from '../../src/functions/identity/execution.js';
import type { RemoteSandboxChannel } from '../../src/remote/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  type ClientDb,
} from '../../src/serve/worker/client.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../src/serve/worker/client/handles.js';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage, SnapMessage } from '../../src/serve/worker/protocol.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const identityFunctions = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');

function createWorkerHarness() {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    subs: new Map(),
    sessionMode: 'LOCAL',
    appOptions: { projectId: 'demo-project' },
  };

  let appClientPort: ClientPort | undefined;
  const appHostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      appClientPort?.onmessage?.({ data: message } as MessageEvent<OutboundMessage>);
    },
  };
  appClientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) {
      void handleMessage(ctx, appHostPort, message);
    },
    start() {},
  };
  wirePort(appClientPort);
  const clientDb: ClientDb = { __kind: 'client-db', port: appClientPort };
  const clientAuth = getClientAuth(clientDb);

  const subCallbacks = new Map<
    string,
    { onSnap: (val: unknown) => void; onError?: (err: unknown) => void }
  >();
  const pendingOps = new Map<
    string,
    { resolve: (val: unknown) => void; reject: (err: unknown) => void }
  >();
  const childHostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      if (message.t === 'snap') {
        const snap = message as SnapMessage;
        const entry = subCallbacks.get(snap.subId);
        const maybeErr = (snap.value as { __error?: { code?: string; message?: string } } | null)?.__error;
        if (maybeErr !== undefined) {
          const err = Object.assign(new Error(maybeErr.message ?? 'sub error'), {
            code: maybeErr.code ?? 'unknown',
          });
          entry?.onError?.(err);
          return;
        }
        entry?.onSnap(snap.value);
      } else if (message.t === 'res') {
        const res = message as ResMessage;
        const waiter = pendingOps.get(res.id);
        if (!waiter) return;
        pendingOps.delete(res.id);
        if (res.ok) {
          waiter.resolve(res.value);
        } else {
          waiter.reject(
            Object.assign(new Error(res.error.message), { code: res.error.code }),
          );
        }
      }
    },
  };

  let seq = 0;
  const childChannel: Pick<RemoteSandboxChannel, 'op' | 'subscribe'> = {
    op(payload) {
      const id = `child-op-${++seq}`;
      const promise = new Promise<unknown>((resolve, reject) => {
        pendingOps.set(id, { resolve, reject });
      });
      void handleMessage(
        ctx,
        childHostPort,
        { ...(payload as Record<string, unknown>), t: 'op', id } as InboundMessage,
      );
      return promise;
    },
    subscribe(sub, onSnap, onError) {
      const subId = `child-sub-${++seq}`;
      subCallbacks.set(subId, { onSnap, onError });
      void handleMessage(
        ctx,
        childHostPort,
        { ...(sub as Record<string, unknown>), t: 'sub', subId } as InboundMessage,
      );
      return () => {
        subCallbacks.delete(subId);
        void handleMessage(ctx, childHostPort, { t: 'unsub', subId });
      };
    },
  };

  return { sandbox, ctx, clientAuth, childHostPort, childChannel };
}

describe('Identity trigger execution host and worker auth-blocking broker', () => {
  test('resolves ready synchronously with zero subscriptions when no triggers are exported', async () => {
    const delivery = new InMemoryIdentityTriggerDelivery();
    const host = startIdentityTriggerExecution({
      exported: {},
      delivery,
    });
    expect(host.triggerCount).toBe(0);
    await host.ready;
    expect(delivery.hasTrigger(BEFORE_CREATE_EVENT_TYPE)).toBe(false);
    await host.idle();
    host.close();
  });

  test('executes async triggers, drains in-flight work on idle(), and stops cleanly on close()', async () => {
    const { beforeUserCreated } = identityFunctions;
    const delivery = new InMemoryIdentityTriggerDelivery();
    let releaseHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const slowCreate = beforeUserCreated(async (event) => {
      await gate;
      return {
        displayName: `Approved ${event.data?.email ?? ''}`,
        customClaims: { checked: true },
      };
    });

    const executions: string[] = [];
    const host = startIdentityTriggerExecution({
      exported: { slowCreate },
      delivery,
      onExecution: (result, trigger) => {
        executions.push(`${trigger.exportName}:${result.status}`);
      },
    });
    expect(host.triggerCount).toBe(1);
    await host.ready;

    const invokePromise = delivery.invoke({
      requestId: 'req-slow-1',
      eventType: BEFORE_CREATE_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-slow', email: 'ada@example.com' },
    });

    let idleDone = false;
    const idlePromise = host.idle().then(() => {
      idleDone = true;
    });
    await Promise.resolve();
    expect(idleDone).toBe(false);

    releaseHandler?.();
    const outcome = await invokePromise;
    await idlePromise;
    expect(idleDone).toBe(true);
    expect(executions).toEqual(['slowCreate:fulfilled']);
    expect(outcome).toEqual({
      ok: true,
      response: {
        displayName: 'Approved ada@example.com',
        customClaims: { checked: true },
      },
    });

    host.close();
    expect(delivery.hasTrigger(BEFORE_CREATE_EVENT_TYPE)).toBe(false);
  });

  test('enforces admin lens on authBlocking sub and fails closed if child disconnects mid-invocation', async () => {
    const { beforeUserCreated } = identityFunctions;
    const h = createWorkerHarness();

    // Non-admin subscription is refused with auth/operation-not-allowed.
    const unauthorizedPortMessages: OutboundMessage[] = [];
    const unauthorizedPort: PortLike = {
      postMessage: (msg) => unauthorizedPortMessages.push(msg),
    };
    await handleMessage(ctxOf(h), unauthorizedPort, {
      t: 'sub',
      subId: 'unauth-sub',
      target: 'authBlocking',
      triggers: [],
    });
    expect(unauthorizedPortMessages).toMatchObject([
      {
        t: 'snap',
        subId: 'unauth-sub',
        value: { __error: { code: 'auth/operation-not-allowed' } },
      },
    ]);

    // Hang inside handler and disconnect child port while client createUser is awaiting.
    let enteredHandler: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      enteredHandler = resolve;
    });
    const neverResolves = new Promise<void>(() => {});
    const hangingCreate = beforeUserCreated(async () => {
      enteredHandler?.();
      await neverResolves;
    });

    const host = startIdentityTriggerExecution({
      exported: { hangingCreate },
      delivery: new RemoteIdentityTriggerDelivery(h.childChannel),
    });
    await host.ready;

    // Attach the rejection handler immediately so disconnect rejection cannot
    // race ahead of `await` and surface as an unhandled rejection.
    const signUpOutcome: Promise<
      { ok: true } | { ok: false; error: unknown }
    > = createUserWithEmailAndPassword(
      h.clientAuth,
      'disconnect@example.com',
      'password123',
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await enteredPromise;

    cleanupPort(h.ctx, h.childHostPort);

    const outcome = await signUpOutcome;
    let rejectedError: (Error & { code?: string }) | undefined;
    if (!outcome.ok && outcome.error instanceof Error) {
      rejectedError = outcome.error as Error & { code?: string };
    }
    expect(outcome.ok).toBe(false);
    expect(rejectedError?.code).toBe('auth/internal-error');
    expect(rejectedError?.message).toContain('UNAVAILABLE');
    expect(authSandbox.listUsers(getAuth(h.sandbox))).toEqual([]);
    host.close();
  });
});

function ctxOf(h: { ctx: HostCtx }): HostCtx {
  return h.ctx;
}
