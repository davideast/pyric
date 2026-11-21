/**
 * Worker-host broker for Identity Platform blocking functions (`authBlocking`
 * subscription + `auth.blockingRespond` op).
 *
 * Connects an isolated Functions child (admin lens) to `pyric/auth`'s
 * `AuthBlockingHooks` seam over `HostCtx`, failing closed without hanging if a
 * child disconnects or exceeds its timeout while an Auth request is awaiting a
 * blocking decision.
 */
import { FirebaseError } from 'pyric/app';
import type { Auth } from 'pyric/auth';
import {
  makeAuthBlockingRejectionError,
  setAuthBlockingHooks,
  type AuthBlockingHooks,
  type BeforeCreateHookResult,
  type BeforeEmailHookResult,
  type BeforeSignInHookResult,
  type BeforeSmsHookResult,
} from 'pyric/auth/internal';
import { getClock, randomUuid, SANDBOX_PROJECT_ID } from 'pyric/sandbox/internal';
import {
  BEFORE_CREATE_EVENT_TYPE,
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
  BEFORE_SIGN_IN_EVENT_TYPE,
} from '../../../functions/identity/discovery.js';
import { fail, hostProjectId, ok, post, type HostCtx, type PortLike } from '../host-context.js';
import {
  serializeError,
  type AuthBlockingInvokeSnapWire,
  type AuthBlockingOutcomeWire,
  type AuthBlockingSubMessage,
  type AuthBlockingTriggerWire,
  type OpMessage,
} from '../protocol.js';

const DEFAULT_BLOCKING_TIMEOUT_SECONDS = 60;

interface RegisteredBlockingSub {
  port: PortLike;
  subId: string;
  triggersByEvent: Map<string, AuthBlockingTriggerWire>;
}

interface PendingBlockingInvocation {
  port: PortLike;
  timer: ReturnType<typeof setTimeout>;
  resolve(outcome: AuthBlockingOutcomeWire): void;
  reject(error: Error): void;
}

interface HostAuthBlockingBrokerState {
  subscriptions: Map<PortLike, Map<string, RegisteredBlockingSub>>;
  activeOrder: RegisteredBlockingSub[];
  pending: Map<string, PendingBlockingInvocation>;
}

const brokerStateByHost = new WeakMap<HostCtx, HostAuthBlockingBrokerState>();

function brokerStateFor(ctx: HostCtx): HostAuthBlockingBrokerState {
  let state = brokerStateByHost.get(ctx);
  if (state === undefined) {
    state = {
      subscriptions: new Map(),
      activeOrder: [],
      pending: new Map(),
    };
    brokerStateByHost.set(ctx, state);
  }
  return state;
}

function findActiveTrigger(
  state: HostAuthBlockingBrokerState,
  eventType: string,
): { sub: RegisteredBlockingSub; trigger: AuthBlockingTriggerWire } | undefined {
  for (let index = state.activeOrder.length - 1; index >= 0; index -= 1) {
    const sub = state.activeOrder[index];
    if (sub === undefined) continue;
    const trigger = sub.triggersByEvent.get(eventType);
    if (trigger !== undefined) {
      return { sub, trigger };
    }
  }
  return undefined;
}

async function dispatchBlockingInvocation(
  ctx: HostCtx,
  state: HostAuthBlockingBrokerState,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const active = findActiveTrigger(state, eventType);
  if (active === undefined) {
    return {};
  }
  const requestId = randomUuid();
  const projectId = hostProjectId(ctx) ?? SANDBOX_PROJECT_ID;
  const timestampMs = getClock(ctx.sandbox).now();
  const timeoutSeconds = active.trigger.timeoutSeconds ?? DEFAULT_BLOCKING_TIMEOUT_SECONDS;
  const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));

  const outcomePromise = new Promise<AuthBlockingOutcomeWire>((resolveOutcome, rejectOutcome) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      rejectOutcome(
        makeAuthBlockingRejectionError({
          status: 'DEADLINE_EXCEEDED',
          message: `Auth blocking function ${active.trigger.exportName} timed out after ${timeoutSeconds}s.`,
        }),
      );
    }, timeoutMs);
    timer.unref?.();
    state.pending.set(requestId, {
      port: active.sub.port,
      timer,
      resolve: resolveOutcome,
      reject: rejectOutcome,
    });
  });

  const invokeSnap: AuthBlockingInvokeSnapWire = {
    kind: 'invoke',
    request: {
      ...payload,
      requestId,
      eventType,
      projectId,
      timestampMs,
    },
  };
  post(active.sub.port, { t: 'snap', subId: active.sub.subId, value: invokeSnap });

  const outcome = await outcomePromise;
  if (!outcome.ok) {
    throw makeAuthBlockingRejectionError({
      status: outcome.error.status,
      message: outcome.error.message,
      details: outcome.error.details,
    });
  }
  return outcome.response;
}

function reconcileHostAuthBlockingHooks(
  ctx: HostCtx,
  auth: Auth,
  state: HostAuthBlockingBrokerState,
): void {
  const hasBeforeCreate = findActiveTrigger(state, BEFORE_CREATE_EVENT_TYPE) !== undefined;
  const hasBeforeSignIn = findActiveTrigger(state, BEFORE_SIGN_IN_EVENT_TYPE) !== undefined;
  const hasBeforeEmail = findActiveTrigger(state, BEFORE_SEND_EMAIL_EVENT_TYPE) !== undefined;
  const hasBeforeSms = findActiveTrigger(state, BEFORE_SEND_SMS_EVENT_TYPE) !== undefined;

  if (!hasBeforeCreate && !hasBeforeSignIn && !hasBeforeEmail && !hasBeforeSms) {
    setAuthBlockingHooks(auth, null);
    return;
  }

  const hooks: AuthBlockingHooks = {};
  if (hasBeforeCreate) {
    hooks.beforeCreate = async (input) => {
      const reqPayload: Record<string, unknown> = {
        userRecord: input.userRecord,
        signInMethod: input.signInMethod,
        tenantId: input.tenantId,
      };
      if (input.client?.locale !== undefined) reqPayload.locale = input.client.locale;
      if (input.client?.ipAddress !== undefined) reqPayload.ipAddress = input.client.ipAddress;
      if (input.client?.userAgent !== undefined) reqPayload.userAgent = input.client.userAgent;
      if (input.client?.recaptchaScore !== undefined) {
        reqPayload.recaptchaScore = input.client.recaptchaScore;
      }
      if (input.client?.rawUserInfo !== undefined) {
        reqPayload.rawUserInfo = input.client.rawUserInfo;
      }
      if (input.client?.credential !== undefined) {
        reqPayload.credential = input.client.credential;
      }
      const response = await dispatchBlockingInvocation(
        ctx,
        state,
        BEFORE_CREATE_EVENT_TYPE,
        reqPayload,
      );
      return response as BeforeCreateHookResult;
    };
  }
  if (hasBeforeSignIn) {
    hooks.beforeSignIn = async (input) => {
      const reqPayload: Record<string, unknown> = {
        userRecord: input.userRecord,
        signInMethod: input.signInMethod,
        tenantId: input.tenantId,
      };
      if (input.client?.locale !== undefined) reqPayload.locale = input.client.locale;
      if (input.client?.ipAddress !== undefined) reqPayload.ipAddress = input.client.ipAddress;
      if (input.client?.userAgent !== undefined) reqPayload.userAgent = input.client.userAgent;
      if (input.client?.recaptchaScore !== undefined) {
        reqPayload.recaptchaScore = input.client.recaptchaScore;
      }
      if (input.client?.rawUserInfo !== undefined) {
        reqPayload.rawUserInfo = input.client.rawUserInfo;
      }
      if (input.client?.credential !== undefined) {
        reqPayload.credential = input.client.credential;
      }
      const response = await dispatchBlockingInvocation(
        ctx,
        state,
        BEFORE_SIGN_IN_EVENT_TYPE,
        reqPayload,
      );
      return response as BeforeSignInHookResult;
    };
  }
  if (hasBeforeEmail) {
    hooks.beforeSendEmail = async (input) => {
      const reqPayload: Record<string, unknown> = {
        email: input.email,
        emailType: input.emailType,
        tenantId: input.tenantId,
      };
      if (input.userRecord !== undefined) reqPayload.userRecord = input.userRecord;
      if (input.client?.locale !== undefined) reqPayload.locale = input.client.locale;
      if (input.client?.ipAddress !== undefined) reqPayload.ipAddress = input.client.ipAddress;
      if (input.client?.userAgent !== undefined) reqPayload.userAgent = input.client.userAgent;
      const response = await dispatchBlockingInvocation(
        ctx,
        state,
        BEFORE_SEND_EMAIL_EVENT_TYPE,
        reqPayload,
      );
      return response as BeforeEmailHookResult;
    };
  }
  if (hasBeforeSms) {
    hooks.beforeSendSms = async (input) => {
      const reqPayload: Record<string, unknown> = {
        phoneNumber: input.phoneNumber,
        smsType: input.smsType,
        tenantId: input.tenantId,
      };
      if (input.userRecord !== undefined) reqPayload.userRecord = input.userRecord;
      if (input.client?.locale !== undefined) reqPayload.locale = input.client.locale;
      if (input.client?.ipAddress !== undefined) reqPayload.ipAddress = input.client.ipAddress;
      if (input.client?.userAgent !== undefined) reqPayload.userAgent = input.client.userAgent;
      const response = await dispatchBlockingInvocation(
        ctx,
        state,
        BEFORE_SEND_SMS_EVENT_TYPE,
        reqPayload,
      );
      return response as BeforeSmsHookResult;
    };
  }

  setAuthBlockingHooks(auth, hooks);
}

/** Register a Functions child's discovered Identity blocking triggers. */
export function handleAuthBlockingSub(
  ctx: HostCtx,
  auth: Auth,
  port: PortLike,
  msg: AuthBlockingSubMessage,
): void {
  if (msg.actAs?.mode !== 'admin') {
    const error = new FirebaseError(
      'auth/operation-not-allowed',
      'Auth blocking trigger subscriptions require the admin lens.',
    );
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(error) } });
    return;
  }
  const state = brokerStateFor(ctx);
  let bySubId = state.subscriptions.get(port);
  if (bySubId === undefined) {
    bySubId = new Map();
    state.subscriptions.set(port, bySubId);
  }
  if (bySubId.has(msg.subId)) return;

  const triggersByEvent = new Map<string, AuthBlockingTriggerWire>();
  for (const trigger of msg.triggers) {
    triggersByEvent.set(trigger.eventType, trigger);
  }
  const entry: RegisteredBlockingSub = {
    port,
    subId: msg.subId,
    triggersByEvent,
  };
  bySubId.set(msg.subId, entry);
  state.activeOrder.push(entry);
  reconcileHostAuthBlockingHooks(ctx, auth, state);

  const readySnap: AuthBlockingInvokeSnapWire = { kind: 'ready' };
  post(port, { t: 'snap', subId: msg.subId, value: readySnap });
}

/** Unsubscribe a Functions child's `authBlocking` subscription. */
export function handleAuthBlockingUnsub(
  ctx: HostCtx,
  auth: Auth,
  port: PortLike,
  subId: string,
): boolean {
  const state = brokerStateByHost.get(ctx);
  if (state === undefined) return false;
  const bySubId = state.subscriptions.get(port);
  const existing = bySubId?.get(subId);
  if (existing === undefined || bySubId === undefined) return false;
  bySubId.delete(subId);
  if (bySubId.size === 0) {
    state.subscriptions.delete(port);
  }
  const orderIdx = state.activeOrder.indexOf(existing);
  if (orderIdx >= 0) {
    state.activeOrder.splice(orderIdx, 1);
  }
  reconcileHostAuthBlockingHooks(ctx, auth, state);
  return true;
}

/** Deliver an `auth.blockingRespond` outcome back to the awaiting Auth operation. */
export function handleAuthBlockingRespond(
  ctx: HostCtx,
  port: PortLike,
  msg: Extract<OpMessage, { method: 'auth.blockingRespond' }>,
): void {
  if (msg.actAs?.mode !== 'admin') {
    fail(
      port,
      msg.id,
      new FirebaseError(
        'auth/operation-not-allowed',
        'Auth blocking responses require the admin lens.',
      ),
    );
    return;
  }
  const state = brokerStateByHost.get(ctx);
  const pending = state?.pending.get(msg.requestId);
  if (pending === undefined || state === undefined) {
    ok(port, msg.id, null);
    return;
  }
  if (pending.port !== port) {
    fail(
      port,
      msg.id,
      new FirebaseError(
        'auth/operation-not-allowed',
        'Auth blocking response did not originate from the owning child port.',
      ),
    );
    return;
  }
  state.pending.delete(msg.requestId);
  clearTimeout(pending.timer);
  pending.resolve(msg.outcome);
  ok(port, msg.id, null);
}

/** Clean up any `authBlocking` registrations and fail pending calls if a child disconnects. */
export function cleanupPortAuthBlocking(ctx: HostCtx, auth: Auth | undefined, port: PortLike): void {
  const state = brokerStateByHost.get(ctx);
  if (state === undefined) return;
  const bySubId = state.subscriptions.get(port);
  if (bySubId !== undefined) {
    for (const sub of bySubId.values()) {
      const idx = state.activeOrder.indexOf(sub);
      if (idx >= 0) {
        state.activeOrder.splice(idx, 1);
      }
    }
    state.subscriptions.delete(port);
    if (auth !== undefined) {
      reconcileHostAuthBlockingHooks(ctx, auth, state);
    }
  }
  for (const [requestId, pending] of [...state.pending.entries()]) {
    if (pending.port === port) {
      state.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(
        makeAuthBlockingRejectionError({
          status: 'UNAVAILABLE',
          message: 'Auth blocking function child disconnected before responding.',
        }),
      );
    }
  }
}
