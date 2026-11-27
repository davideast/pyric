/**
 * Read-only Auth user lifecycle subscription on the worker host for Cloud
 * Functions Gen 1 Auth triggers (`providers/firebase.auth/eventTypes/user.create`
 * and `user.delete`).
 *
 * Listens on the existing `ctx.sandbox.onEvent` stream and relays each live
 * committed `auth` `user_create` / `user_delete` service mutation as a
 * JSON-safe `snap` message without replaying prior `sandbox.history()`.
 */
import { FirebaseError } from 'pyric/app';
import type { SandboxEvent } from 'pyric/sandbox';
import { post, type HostCtx, type PortLike } from '../host-context.js';
import { serializeError, type AuthLifecycleSubMessage } from '../protocol.js';

export interface AuthLifecycleProviderInfoWire {
  readonly providerId: string;
  readonly uid?: string;
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly photoURL?: string | null;
  readonly phoneNumber?: string | null;
}

export interface AuthLifecycleUserWire {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly phoneNumber: string | null;
  readonly photoUrl: string | null;
  readonly customClaims: Record<string, unknown>;
  readonly providerUserInfo: readonly AuthLifecycleProviderInfoWire[];
  readonly isAnonymous: boolean;
  readonly disabled: boolean;
  readonly emailVerified: boolean;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly lastRefreshAt?: string | null;
  readonly tokensValidAfterMs?: number;
}

export type AuthLifecycleSnapWire =
  | {
      readonly kind: 'ready';
    }
  | {
      readonly kind: 'mutation';
      readonly op: 'user_create' | 'user_delete';
      readonly uid: string;
      readonly at: number;
      readonly user: AuthLifecycleUserWire;
    };

interface AuthLifecycleMutationEventShape {
  kind: 'service_mutation';
  service: 'auth';
  op: 'user_create' | 'user_delete';
  at: number;
  path?: string;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthLifecycleMutationEvent(
  event: SandboxEvent,
): event is SandboxEvent & AuthLifecycleMutationEventShape {
  if (event.kind !== 'service_mutation') return false;
  if (event.service !== 'auth') return false;
  return event.op === 'user_create' || event.op === 'user_delete';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeProviderUserInfo(raw: unknown): AuthLifecycleProviderInfoWire[] {
  if (!Array.isArray(raw)) return [];
  const entries: AuthLifecycleProviderInfoWire[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item) || typeof item.providerId !== 'string' || item.providerId.length === 0) {
      continue;
    }
    const entry: {
      providerId: string;
      uid?: string;
      displayName?: string | null;
      email?: string | null;
      photoURL?: string | null;
      phoneNumber?: string | null;
    } = { providerId: item.providerId };
    if (typeof item.uid === 'string' && item.uid.length > 0) entry.uid = item.uid;
    if (typeof item.displayName === 'string' || item.displayName === null) {
      entry.displayName = item.displayName;
    }
    if (typeof item.email === 'string' || item.email === null) {
      entry.email = item.email;
    }
    if (typeof item.photoURL === 'string' || item.photoURL === null) {
      entry.photoURL = item.photoURL;
    } else if (typeof item.photoUrl === 'string' || item.photoUrl === null) {
      entry.photoURL = item.photoUrl;
    }
    if (typeof item.phoneNumber === 'string' || item.phoneNumber === null) {
      entry.phoneNumber = item.phoneNumber;
    }
    entries.push(entry);
  }
  return entries;
}

function toWireUser(raw: unknown, fallbackUid: string, fallbackAt: number): AuthLifecycleUserWire | null {
  if (!isPlainRecord(raw)) return null;
  const uid = typeof raw.uid === 'string' && raw.uid.length > 0 ? raw.uid : fallbackUid;
  if (uid.length === 0) return null;

  let photoUrl: string | null = null;
  if (typeof raw.photoUrl === 'string') {
    photoUrl = raw.photoUrl;
  } else if (typeof raw.photoURL === 'string') {
    photoUrl = raw.photoURL;
  }

  const customClaims = isPlainRecord(raw.customClaims)
    ? (structuredClone(raw.customClaims) as Record<string, unknown>)
    : {};

  let createdAt: string;
  if (typeof raw.createdAt === 'string' && raw.createdAt.length > 0) {
    createdAt = raw.createdAt;
  } else {
    createdAt = new Date(fallbackAt > 0 ? fallbackAt : Date.now()).toISOString();
  }

  const out: {
    uid: string;
    email: string | null;
    displayName: string | null;
    phoneNumber: string | null;
    photoUrl: string | null;
    customClaims: Record<string, unknown>;
    providerUserInfo: AuthLifecycleProviderInfoWire[];
    isAnonymous: boolean;
    disabled: boolean;
    emailVerified: boolean;
    tenantId: string | null;
    createdAt: string;
    lastLoginAt: string | null;
    lastRefreshAt?: string | null;
    tokensValidAfterMs?: number;
  } = {
    uid,
    email: nullableString(raw.email),
    displayName: nullableString(raw.displayName),
    phoneNumber: nullableString(raw.phoneNumber),
    photoUrl,
    customClaims,
    providerUserInfo: normalizeProviderUserInfo(raw.providerUserInfo ?? raw.providerData),
    isAnonymous: raw.isAnonymous === true,
    disabled: raw.disabled === true,
    emailVerified: raw.emailVerified === true,
    tenantId: nullableString(raw.tenantId),
    createdAt,
    lastLoginAt: nullableString(raw.lastLoginAt),
  };

  if (typeof raw.lastRefreshAt === 'string' || raw.lastRefreshAt === null) {
    out.lastRefreshAt = raw.lastRefreshAt;
  }
  if (typeof raw.tokensValidAfterMs === 'number' && Number.isFinite(raw.tokensValidAfterMs)) {
    out.tokensValidAfterMs = raw.tokensValidAfterMs;
  }
  return out;
}

function ensurePortSubs(ctx: HostCtx, port: PortLike): Map<string, () => void> {
  let portSubs = ctx.subs.get(port);
  if (portSubs === undefined) {
    portSubs = new Map();
    ctx.subs.set(port, portSubs);
  }
  return portSubs;
}

export function handleAuthLifecycleSub(
  ctx: HostCtx,
  port: PortLike,
  msg: AuthLifecycleSubMessage,
): void {
  const portSubs = ensurePortSubs(ctx, port);
  if (portSubs.has(msg.subId)) return;

  if (msg.actAs?.mode !== 'admin') {
    const error = new FirebaseError(
      'auth/insufficient-permission',
      'Auth lifecycle trigger subscriptions require the admin lens.',
    );
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(error) } });
    return;
  }

  let closed = false;
  const stopOnEvent = ctx.sandbox.onEvent((event) => {
    if (closed || !isAuthLifecycleMutationEvent(event)) return;
    if (event.detail?.rollback === true) return;
    const rawUser = event.op === 'user_create' ? event.after : event.before;
    const fallbackUid = typeof event.path === 'string' ? event.path : '';
    const user = toWireUser(rawUser, fallbackUid, event.at);
    if (user === null) return;

    const payload: AuthLifecycleSnapWire = {
      kind: 'mutation',
      op: event.op,
      uid: user.uid,
      at: event.at,
      user,
    };
    post(port, { t: 'snap', subId: msg.subId, value: payload });
  });

  portSubs.set(msg.subId, () => {
    closed = true;
    stopOnEvent();
  });

  const readySnap: AuthLifecycleSnapWire = { kind: 'ready' };
  post(port, { t: 'snap', subId: msg.subId, value: readySnap });
}
