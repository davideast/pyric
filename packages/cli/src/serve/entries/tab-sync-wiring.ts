import type { Auth, SeedUser } from 'pyric/auth';

interface AuthStateMessage {
  kind: 'state';
  origin: string;
  users: SeedUser[];
}

interface AuthHelloMessage {
  kind: 'hello';
  origin: string;
}

type AuthSyncMessage = AuthStateMessage | AuthHelloMessage;

function isAuthSyncMessage(value: unknown): value is AuthSyncMessage {
  const isRecord = typeof value === 'object' && value !== null;
  const isNotRecord = !isRecord;
  if (isNotRecord) return false;
  const hasOrigin = 'origin' in value && typeof value.origin === 'string';
  const hasKind = 'kind' in value;
  const hasEnvelope = hasOrigin && hasKind;
  const hasNoEnvelope = !hasEnvelope;
  if (hasNoEnvelope) return false;
  const isHello = value.kind === 'hello';
  const isState = value.kind === 'state' && 'users' in value && Array.isArray(value.users);
  return isHello || isState;
}

/** Shared accounts propagate between fallback tabs; each app owns its session. */
export interface AuthOps {
  exportUsers(auth: Auth): SeedUser[];
  seedUsers(auth: Auth, users: ReadonlyArray<SeedUser>): void;
  subscribeUsers(auth: Auth, callback: () => void): () => void;
}

interface AuthChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/** Synchronize account records without broadcasting or restoring a tab's signed-in UID. */
export function wireAuthTabSync(
  auth: Auth,
  authOps: AuthOps,
  channel?: AuthChannel,
  originId?: string,
): () => void {
  const hasNoChannel = channel === undefined && typeof BroadcastChannel === 'undefined';
  if (hasNoChannel) return () => {};
  const bc = channel ?? new BroadcastChannel('pyric:serve:auth-sync');
  const ownsChannel = channel === undefined;
  const hasRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const origin = originId ?? (hasRandomUUID ? crypto.randomUUID() : `auth-tab-${Date.now()}-${Math.random()}`);
  let applyingRemoteAuth = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;

  function broadcastAccounts(): void {
    bc.postMessage({ kind: 'state', origin, users: authOps.exportUsers(auth) } satisfies AuthStateMessage);
  }

  const unsubscribe = authOps.subscribeUsers(auth, () => {
    if (applyingRemoteAuth) return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(broadcastAccounts, 100);
  });

  function receive(event: { data: unknown }): void {
    const message = event.data;
    const isMessage = isAuthSyncMessage(message);
    const isInvalidMessage = !isMessage;
    if (isInvalidMessage) return;
    const isOwnMessage = message.origin === origin;
    if (isOwnMessage) return;
    const requestsAccounts = message.kind === 'hello';
    if (requestsAccounts) {
      broadcastAccounts();
      return;
    }
    // seedUsers synchronously notifies account subscribers. Suppress their echo.
    applyingRemoteAuth = true;
    try {
      authOps.seedUsers(auth, message.users);
    } finally {
      applyingRemoteAuth = false;
    }
  }

  bc.addEventListener('message', receive);
  bc.postMessage({ kind: 'hello', origin } satisfies AuthHelloMessage);
  return () => {
    clearTimeout(broadcastTimer);
    unsubscribe();
    bc.removeEventListener('message', receive);
    if (ownsChannel) bc.close();
  };
}
