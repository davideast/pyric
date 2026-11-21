import { recordBackendOverBlob, type LocalSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authOps } from 'pyric/auth';
import type { InitPayload } from '../init-payload.js';
import { keepaliveSafe } from './keepalive.js';
import { onServiceUsed } from './service-use.js';

export interface InPagePersistenceDiagnostics {
  persistEnabled: boolean;
  lastFlushAt: number | null;
  persistReadOnly: boolean;
}

/**
 * Attach durable `/__pyric/state` persistence for an in-page sandbox.
 *
 * The sandbox's persistence controller owns restore-on-attach, debounced
 * auto-flush, and the beforeunload safety flush; auth user records flush
 * separately to `?section=auth`.
 */
export async function setupInPagePersistence(
  sandbox: LocalSandbox,
  payload: InitPayload,
  diagnostics: InPagePersistenceDiagnostics,
): Promise<void> {
  const section = (name: string): string => `/__pyric/state?section=${name}`;
  // Single-writer lock (pre-mortem #3): a per-page id claims the writer role on
  // first service use; a second tab gets 423 and drops to read-only so it
  // cannot erase this tab's world. The server frees a stale lock, so a reload
  // after the writer closed can reclaim it.
  const hasRandomUuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const writerId = hasRandomUuid ? crypto.randomUUID() : `w-${Date.now()}`;
  const sessionTokenHeaders: Record<string, string> = {};
  if (payload.sessionToken) {
    sessionTokenHeaders['x-pyric-session-token'] = payload.sessionToken;
  }
  const writerHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-pyric-writer': writerId,
    ...sessionTokenHeaders,
  };
  let readOnly = false;
  // The writer role is claimed once the page uses a service (its first
  // getAuth, getFirestore, getDatabase or getStorage, or its first sandbox
  // event), not on load: a page that imports no Firebase service still loads
  // this runtime through the page script and must leave the role free.
  let claimsWriterRole = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const lostWriterLock = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (readOnly) return;
    readOnly = true;
    diagnostics.persistReadOnly = true;
    console.warn(
      '[pyric sandbox] another tab is the persist writer. This tab is read-only ' +
        '(your changes here will NOT be saved). Close the other tab and reload to take over.',
    );
  };
  await sandbox.enablePersistence({
    key: 'pyric-serve',
    injectedBackend: recordBackendOverBlob({
      async read() {
        const res = await fetch(section('firestore'), { headers: sessionTokenHeaders });
        if (res.status === 200) return await res.text();
        return null;
      },
      async write(value) {
        if (readOnly) return;
        if (!claimsWriterRole) return;
        const res = await fetch(section('firestore'), {
          method: 'POST',
          headers: writerHeaders,
          body: value,
          keepalive: keepaliveSafe(value),
        });
        if (res.status === 423) {
          lostWriterLock();
          return;
        }
        if (!res.ok) throw new Error(`state flush -> ${res.status}`);
        diagnostics.lastFlushAt = Date.now();
      },
      async clear() {
        if (readOnly) return;
        await fetch(section('firestore'), { method: 'POST', headers: writerHeaders, body: 'null' });
      },
    }),
  });
  diagnostics.persistEnabled = true;

  const sendHeartbeat = (): void => {
    if (readOnly) return;
    void fetch('/__pyric/state', { method: 'PUT', headers: writerHeaders }).then((res) => {
      if (res.status === 423) lostWriterLock();
    }, () => {});
  };
  const claimWriterRole = (): void => {
    if (claimsWriterRole) return;
    claimsWriterRole = true;
    sendHeartbeat();
    heartbeat = setInterval(sendHeartbeat, 20_000);
  };
  onServiceUsed(claimWriterRole);
  const stopClaimOnEvent = sandbox.onEvent(() => {
    stopClaimOnEvent();
    claimWriterRole();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (!readOnly && claimsWriterRole) {
        fetch('/__pyric/state', { method: 'DELETE', headers: writerHeaders, keepalive: true }).catch(() => {});
      }
    });
  }

  const auth = getAuth(sandbox);
  let authFlushTimer: ReturnType<typeof setTimeout> | null = null;
  authOps.subscribeUsers(auth, () => {
    if (readOnly || !claimsWriterRole) return;
    if (authFlushTimer !== null) clearTimeout(authFlushTimer);
    authFlushTimer = setTimeout(() => {
      void fetch(section('auth'), {
        method: 'POST',
        headers: writerHeaders,
        body: JSON.stringify({ users: authOps.exportUsers(auth) }),
      }).then(
        (res) => {
          if (res.status === 423) lostWriterLock();
          else if (res.ok) diagnostics.lastFlushAt = Date.now();
        },
        (e: unknown) => console.warn('[pyric sandbox] auth state flush failed:', e),
      );
    }, 500);
  });
}
