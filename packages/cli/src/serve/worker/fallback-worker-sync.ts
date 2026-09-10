/**
 * Mixed-mode fallback-worker sync bridge (fallback-worker-sync).
 *
 * Connects the SharedWorker host to the fallback tab-sync channels:
 *   - 'pyric:serve:tabsync' for Firestore cross-tab synchronization
 *   - 'pyric:serve:auth-sync' for Auth user-directory synchronization
 *
 * This resolves the transport mismatch between tabs running under SharedWorker
 * and in-page fallback tabs (or tabs opened where SharedWorker is unavailable),
 * preventing silent split-brain database states.
 */

import { sandbox as authOps } from 'pyric/auth';
import type { HostCtx } from './host-context.js';
import { ensureAuth } from './host-auth.js';

export const FIRESTORE_TAB_SYNC_CHANNEL = 'pyric:serve:tabsync';
export const AUTH_TAB_SYNC_CHANNEL = 'pyric:serve:auth-sync';

interface AuthStateMessage {
  kind: 'state';
  origin: string;
  users: Parameters<typeof authOps.seedUsers>[1];
  currentUid: string | null;
}

interface AuthHelloMessage {
  kind: 'hello';
  origin: string;
}

type AuthSyncMessage = AuthStateMessage | AuthHelloMessage;

function isAuthSyncMessage(v: unknown): v is AuthSyncMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).kind === 'string' &&
    typeof (v as Record<string, unknown>).origin === 'string'
  );
}

/**
 * Setup fallback-worker sync bridge to handle mixed-mode transport mismatch.
 *
 * Attaches listeners to 'pyric:serve:tabsync' and 'pyric:serve:auth-sync' so
 * the authoritative SharedWorker host and any fallback tabs remain in sync.
 */
export function setupFallbackWorkerSync(ctx: HostCtx): (() => void) | undefined {
  if (typeof BroadcastChannel === 'undefined') {
    return undefined;
  }

  // 1. Firestore tab-sync bridge: enableTabSync attaches BroadcastChannel
  // listeners and onEvent listeners so writes flow bidirectionally between
  // worker-mode tabs and in-page fallback tabs on 'pyric:serve:tabsync'.
  const disableTabSync = ctx.sandbox.enableTabSync({
    channel: new BroadcastChannel(FIRESTORE_TAB_SYNC_CHANNEL),
  });

  // 2. Auth user-directory sync bridge: synchronizes user accounts between
  // the SharedWorker's auth user pool and fallback tabs on 'pyric:serve:auth-sync'.
  const auth = ensureAuth(ctx);
  const authChannel = new BroadcastChannel(AUTH_TAB_SYNC_CHANNEL);
  const origin = `worker-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;

  let applyingRemote = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function broadcastUsers(): void {
    if (applyingRemote) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (applyingRemote) return;
      const msg: AuthStateMessage = {
        kind: 'state',
        origin,
        users: authOps.exportUsers(auth),
        currentUid: null,
      };
      authChannel.postMessage(msg);
    }, 100);
  }

  const unsubUsers = authOps.subscribeUsers(auth, broadcastUsers);

  const handleAuthMessage = (ev: { data: unknown }): void => {
    if (!isAuthSyncMessage(ev.data)) return;
    const msg = ev.data;
    if (msg.origin === origin) return;

    if (msg.kind === 'hello') {
      const stateMsg: AuthStateMessage = {
        kind: 'state',
        origin,
        users: authOps.exportUsers(auth),
        currentUid: null,
      };
      authChannel.postMessage(stateMsg);
      return;
    }

    if (msg.kind === 'state') {
      applyingRemote = true;
      try {
        if (Array.isArray(msg.users)) {
          authOps.seedUsers(auth, msg.users);
        }
      } finally {
        applyingRemote = false;
      }
    }
  };

  authChannel.addEventListener('message', handleAuthMessage);

  // Announce worker presence to existing fallback tabs
  const helloMsg: AuthHelloMessage = { kind: 'hello', origin };
  authChannel.postMessage(helloMsg);

  const teardown = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    unsubUsers();
    authChannel.removeEventListener('message', handleAuthMessage);
    authChannel.close();
    disableTabSync();
  };

  ctx.fallbackWorkerSyncTeardown = teardown;
  return teardown;
}
