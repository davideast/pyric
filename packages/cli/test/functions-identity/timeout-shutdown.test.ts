import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getAuth as getSandboxAuth, sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import {
  InMemoryIdentityTriggerDelivery,
  RemoteIdentityTriggerDelivery,
} from '../../src/functions/identity/delivery.js';
import {
  BEFORE_CREATE_EVENT_TYPE,
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
  BEFORE_SIGN_IN_EVENT_TYPE,
  discoverIdentityTriggers,
} from '../../src/functions/identity/discovery.js';
import { startIdentityTriggerExecution } from '../../src/functions/identity/execution.js';
import { DEFAULT_IDENTITY_TIMEOUT_SECONDS } from '../../src/functions/identity/response.js';
import type { RemoteSandboxChannel } from '../../src/remote/index.js';
import {
  createUserWithEmailAndPassword as createWorkerEmailUser,
  getAuth as getWorkerClientAuth,
  sendAuthSmsVerification,
  sendPasswordResetEmail as sendWorkerPasswordReset,
  signInWithEmailAndPassword as signInWorkerEmailUser,
  takeAuthMail,
  takeAuthSms,
  type ClientDb,
} from '../../src/serve/worker/client.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../src/serve/worker/client/handles.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
} from '../../src/serve/worker/protocol.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const identityFunctions = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');
const v2Options = requireFromConformance(
  'firebase-functions/v2/options',
) as typeof import('firebase-functions/v2/options');

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
  const clientAuth = getWorkerClientAuth(clientDb);

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
        const maybeErr = (
          snap.value as { __error?: { code?: string; message?: string } } | null
        )?.__error;
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

describe('Identity blocking timeoutSeconds enforcement, unsub cancellation, and close() drainage', () => {
  test('enforces per-trigger timeoutSeconds with DEADLINE_EXCEEDED across all 4 triggers and drains idle()', async () => {
    expect(DEFAULT_IDENTITY_TIMEOUT_SECONDS).toBe(60);
    const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } =
      identityFunctions;
    const stallForever = () => new Promise<never>(() => {});

    const slowCreate = beforeUserCreated({ timeoutSeconds: 0.05 }, stallForever);
    const slowSignIn = beforeUserSignedIn({ timeoutSeconds: 0.05 }, stallForever);
    const slowEmail = beforeEmailSent({ timeoutSeconds: 0.05 }, stallForever);
    const slowSms = beforeSmsSent({ timeoutSeconds: 0.05 }, stallForever);

    const delivery = new InMemoryIdentityTriggerDelivery();
    const recorded: Array<{ exportName: string; status: string; code?: string }> = [];
    const host = startIdentityTriggerExecution({
      exported: { slowCreate, slowSignIn, slowEmail, slowSms },
      delivery,
      onExecution(result, trigger) {
        if (result.status === 'rejected') {
          recorded.push({
            exportName: trigger.exportName,
            status: result.status,
            code: result.error.code,
          });
        } else {
          recorded.push({ exportName: trigger.exportName, status: result.status });
        }
      },
    });
    expect(host.triggerCount).toBe(4);
    await host.ready;

    const startedAt = Date.now();
    const outcomes = await Promise.all([
      delivery.invoke({
        requestId: 'req-t-create',
        eventType: BEFORE_CREATE_EVENT_TYPE,
        projectId: 'demo-project',
        timestampMs: Date.now(),
        signInMethod: 'password',
        userRecord: { uid: 'u-t1', email: 't1@example.com' },
      }),
      delivery.invoke({
        requestId: 'req-t-signin',
        eventType: BEFORE_SIGN_IN_EVENT_TYPE,
        projectId: 'demo-project',
        timestampMs: Date.now(),
        signInMethod: 'password',
        userRecord: { uid: 'u-t1', email: 't1@example.com' },
      }),
      delivery.invoke({
        requestId: 'req-t-email',
        eventType: BEFORE_SEND_EMAIL_EVENT_TYPE,
        projectId: 'demo-project',
        timestampMs: Date.now(),
        email: 't1@example.com',
        emailType: 'PASSWORD_RESET',
      }),
      delivery.invoke({
        requestId: 'req-t-sms',
        eventType: BEFORE_SEND_SMS_EVENT_TYPE,
        projectId: 'demo-project',
        timestampMs: Date.now(),
        phoneNumber: '+15550101111',
        smsType: 'SIGN_IN_OR_SIGN_UP',
      }),
    ]);

    await host.idle();
    expect(Date.now() - startedAt).toBeLessThan(2000);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          code: 'deadline-exceeded',
          status: 'DEADLINE_EXCEEDED',
          httpStatus: 504,
        },
      });
    }
    expect(recorded).toHaveLength(4);
    expect(recorded.every((item) => item.code === 'deadline-exceeded')).toBe(true);
    host.close();
  });

  test('honors defaultTimeoutSeconds fallback, preserves RESET_VALUE, and allows per-function override', async () => {
    const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent } = identityFunctions;
    const inheritedTimeout = beforeUserCreated({ preserveExternalChanges: true }, async () => {
      await new Promise(() => {});
    });
    const resetTimeout = beforeEmailSent({ timeoutSeconds: v2Options.RESET_VALUE }, async () => ({}));
    const explicitOverride = beforeUserSignedIn({ timeoutSeconds: 2 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return { sessionClaims: { fastEnough: true } };
    });

    const discovered = discoverIdentityTriggers(
      { inheritedTimeout, resetTimeout, explicitOverride },
      { defaultTimeoutSeconds: 0.04 },
    );
    expect(discovered.find((t) => t.exportName === 'inheritedTimeout')?.timeoutSeconds).toBe(0.04);
    expect(discovered.find((t) => t.exportName === 'resetTimeout')?.timeoutSeconds).toBeUndefined();
    expect(discovered.find((t) => t.exportName === 'explicitOverride')?.timeoutSeconds).toBe(2);

    const delivery = new InMemoryIdentityTriggerDelivery();
    const host = startIdentityTriggerExecution({
      exported: { inheritedTimeout, resetTimeout, explicitOverride },
      delivery,
      defaultTimeoutSeconds: 0.04,
    });
    await host.ready;

    const timedOut = await delivery.invoke({
      requestId: 'req-default-timeout',
      eventType: BEFORE_CREATE_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-def', email: 'def@example.com' },
    });
    expect(timedOut).toMatchObject({
      ok: false,
      error: { code: 'deadline-exceeded', status: 'DEADLINE_EXCEEDED' },
    });

    const overridden = await delivery.invoke({
      requestId: 'req-override-timeout',
      eventType: BEFORE_SIGN_IN_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-def', email: 'def@example.com' },
    });
    expect(overridden).toEqual({
      ok: true,
      response: { sessionClaims: { fastEnough: true } },
    });
    await host.idle();
    host.close();
  });

  test('aborts wedged long-timeout handlers on close() and fails pending worker calls on unsub', async () => {
    const { beforeUserCreated } = identityFunctions;
    const h = createWorkerHarness();
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wedgedCreate = beforeUserCreated({ timeoutSeconds: 7 }, async () => {
      markEntered?.();
      await new Promise(() => {});
    });

    const host = startIdentityTriggerExecution({
      exported: { wedgedCreate },
      delivery: new RemoteIdentityTriggerDelivery(h.childChannel),
    });
    await host.ready;

    // Attach the rejection handler immediately so unsub rejection during
    // `host.close()` / `await host.idle()` cannot surface as an unhandled error.
    const pendingSignUpOutcome: Promise<
      { ok: true } | { ok: false; error: unknown }
    > = createWorkerEmailUser(
      h.clientAuth,
      'unsub-victim@example.com',
      'password123',
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await entered;

    const closeStart = Date.now();
    host.close();
    await host.idle();
    expect(Date.now() - closeStart).toBeLessThan(1000);

    const outcome = await pendingSignUpOutcome;
    let caught: (Error & { code?: string }) | undefined;
    if (!outcome.ok && outcome.error instanceof Error) {
      caught = outcome.error as Error & { code?: string };
    }
    expect(outcome.ok).toBe(false);
    expect(caught?.code).toBe('auth/internal-error');
    expect(caught?.message).toContain('UNAVAILABLE');
    expect(authSandbox.listUsers(getSandboxAuth(h.sandbox))).toEqual([]);
  });

  test('enforces worker-host safety-net DEADLINE_EXCEEDED across all 4 triggers when port never replies', async () => {
    const h = createWorkerHarness();
    authSandbox.createUser(getSandboxAuth(h.sandbox), {
      uid: 'existing-u1',
      email: 'existing@example.com',
      password: 'password123',
    });

    const silentPort: PortLike = { postMessage() {} };
    const defaultOptions = { idToken: false, accessToken: false, refreshToken: false };
    await handleMessage(h.ctx, silentPort, {
      t: 'sub',
      subId: 'silent-blocking-sub',
      target: 'authBlocking',
      actAs: { mode: 'admin' },
      triggers: [
        { exportName: 's1', eventType: BEFORE_CREATE_EVENT_TYPE, options: defaultOptions, timeoutSeconds: 0.03 },
        { exportName: 's2', eventType: BEFORE_SIGN_IN_EVENT_TYPE, options: defaultOptions, timeoutSeconds: 0.03 },
        { exportName: 's3', eventType: BEFORE_SEND_EMAIL_EVENT_TYPE, options: defaultOptions, timeoutSeconds: 0.03 },
        { exportName: 's4', eventType: BEFORE_SEND_SMS_EVENT_TYPE, options: defaultOptions, timeoutSeconds: 0.03 },
      ],
    });

    for (const op of [
      () => createWorkerEmailUser(h.clientAuth, 'new@example.com', 'password123'),
      () => signInWorkerEmailUser(h.clientAuth, 'existing@example.com', 'password123'),
      () => sendWorkerPasswordReset(h.clientAuth, 'existing@example.com'),
      () => sendAuthSmsVerification(h.clientAuth, { phoneNumber: '+15550102222', smsType: 'SIGN_IN_OR_SIGN_UP' }),
    ]) {
      let errObj: Error | undefined;
      try {
        await op();
      } catch (err) {
        errObj = err as Error;
      }
      expect(errObj?.message).toContain('DEADLINE_EXCEEDED');
    }

    expect(authSandbox.listUsers(getSandboxAuth(h.sandbox)).map((u) => u.uid)).toEqual([
      'existing-u1',
    ]);
    expect(await takeAuthMail(h.clientAuth)).toBeNull();
    expect(await takeAuthSms(h.clientAuth)).toBeNull();
  });
});
