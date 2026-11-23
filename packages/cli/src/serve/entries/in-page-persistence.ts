import { recordBackendOverBlob, type LocalSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authOps } from 'pyric/auth';
import type { InitPayload } from '../init-payload.js';
import { parseStateVersionHeader, STATE_VERSION_HEADER } from '../writer-lock.js';
import { keepaliveSafe } from './keepalive.js';
import { onServiceUsed } from './service-use.js';

export interface InPagePersistenceDiagnostics {
  persistEnabled: boolean;
  lastFlushAt: number | null;
  persistReadOnly: boolean;
}

export interface InPagePersistenceCallbacks {
  /** Fired once when this tab wins its initial writer claim. */
  onWriterClaimed?: () => void;
  /** Fired if this tab loses or is refused the writer role (423 or 409). */
  onWriterLost?: () => void;
}

function isWriterRefusalStatus(status: number): boolean {
  return status === 423 || status === 409;
}

/**
 * Attach durable `/__pyric/state` persistence for an in-page sandbox.
 *
 * Every claim (`PUT`) and save (`POST`) carries `x-pyric-state-version` with
 * the state version this tab loaded or last saved, serialized per tab so
 * concurrent `firestore` and `auth` flushes advance the version cleanly without
 * self-conflict (#2051).
 */
export async function setupInPagePersistence(
  sandbox: LocalSandbox,
  payload: InitPayload,
  diagnostics: InPagePersistenceDiagnostics,
  callbacks: InPagePersistenceCallbacks = {},
): Promise<void> {
  const section = (name: string): string => `/__pyric/state?section=${name}`;
  const hasRandomUuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  let writerId = `w-${Date.now()}`;
  if (hasRandomUuid) {
    writerId = crypto.randomUUID();
  }
  const sessionTokenHeaders: Record<string, string> = {};
  if (payload.sessionToken) {
    sessionTokenHeaders['x-pyric-session-token'] = payload.sessionToken;
  }
  let stateVersion: number | null = null;
  if (typeof payload.stateVersion === 'number') {
    stateVersion = payload.stateVersion;
  }
  let readOnly = false;
  let claimsWriterRole = false;
  let writerGranted = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let authFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let authClearEpoch = 0;
  let inFlight: Promise<void> | null = null;

  const buildWriterHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-pyric-writer': writerId,
      ...sessionTokenHeaders,
    };
    if (stateVersion !== null) {
      headers[STATE_VERSION_HEADER] = String(stateVersion);
    }
    return headers;
  };

  const recordVersionFromResponse = (res: Response): void => {
    if (typeof res.headers?.get !== 'function') return;
    const parsed = parseStateVersionHeader(res.headers.get(STATE_VERSION_HEADER));
    if (typeof parsed === 'number') {
      stateVersion = parsed;
    }
  };

  const markWriterGranted = (): void => {
    if (writerGranted || readOnly) return;
    writerGranted = true;
    callbacks.onWriterClaimed?.();
  };

  const lostWriterLock = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (readOnly) return;
    readOnly = true;
    diagnostics.persistReadOnly = true;
    callbacks.onWriterLost?.();
    console.warn(
      '[pyric sandbox] another tab is the persist writer or saved newer state. This tab is read-only ' +
        '(your changes here will NOT be saved). Close the other tab and reload to take over.',
    );
  };

  // Run outbound PUT/POST state requests sequentially per tab while starting
  // immediately when idle so beforeunload keepalive fetches fire synchronously.
  const runSerialized = (op: () => Promise<void>): Promise<void> => {
    let next: Promise<void>;
    if (inFlight === null) {
      next = op();
    } else {
      next = inFlight.then(op, op);
    }
    const tracked = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
    inFlight = tracked;
    return next;
  };

  await sandbox.enablePersistence({
    key: 'pyric-serve',
    injectedBackend: recordBackendOverBlob({
      async read() {
        const res = await fetch(section('firestore'), { headers: sessionTokenHeaders });
        if (stateVersion === null && typeof res.headers?.get === 'function') {
          const parsed = parseStateVersionHeader(res.headers.get(STATE_VERSION_HEADER));
          if (typeof parsed === 'number') {
            stateVersion = parsed;
          }
        }
        if (res.status === 200) return await res.text();
        return null;
      },
      async write(value) {
        if (readOnly || !claimsWriterRole) return;
        await runSerialized(async () => {
          if (readOnly || !claimsWriterRole) return;
          const res = await fetch(section('firestore'), {
            method: 'POST',
            headers: buildWriterHeaders(),
            body: value,
            keepalive: keepaliveSafe(value),
          });
          if (isWriterRefusalStatus(res.status)) {
            lostWriterLock();
            return;
          }
          if (!res.ok) throw new Error(`state flush -> ${res.status}`);
          recordVersionFromResponse(res);
          markWriterGranted();
          diagnostics.lastFlushAt = Date.now();
        });
      },
      async clear() {
        authClearEpoch += 1;
        if (authFlushTimer !== null) {
          clearTimeout(authFlushTimer);
          authFlushTimer = null;
        }
        if (readOnly || !claimsWriterRole) return;
        await runSerialized(async () => {
          if (readOnly || !claimsWriterRole) return;
          const res = await fetch(section('firestore'), {
            method: 'POST',
            headers: buildWriterHeaders(),
            body: 'null',
          });
          if (isWriterRefusalStatus(res.status)) {
            lostWriterLock();
            return;
          }
          if (res.ok) {
            recordVersionFromResponse(res);
            markWriterGranted();
          }
          const authRes = await fetch(section('auth'), {
            method: 'POST',
            headers: buildWriterHeaders(),
            body: 'null',
          });
          if (isWriterRefusalStatus(authRes.status)) {
            lostWriterLock();
            return;
          }
          if (authRes.ok) {
            recordVersionFromResponse(authRes);
            markWriterGranted();
          }
        });
      },
    }),
  });
  diagnostics.persistEnabled = true;

  const sendHeartbeat = (): void => {
    if (readOnly) return;
    void runSerialized(async () => {
      if (readOnly) return;
      try {
        const res = await fetch('/__pyric/state', {
          method: 'PUT',
          headers: buildWriterHeaders(),
        });
        if (isWriterRefusalStatus(res.status)) {
          lostWriterLock();
          return;
        }
        if (res.ok) {
          recordVersionFromResponse(res);
          markWriterGranted();
        }
      } catch {
        // Transient heartbeat failure; next interval or write retries.
      }
    });
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
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && claimsWriterRole && !readOnly) {
        sendHeartbeat();
      }
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (!readOnly && claimsWriterRole) {
        fetch('/__pyric/state', {
          method: 'DELETE',
          headers: buildWriterHeaders(),
          keepalive: true,
        }).catch(() => {
          // Page is unloading; best-effort lock release only.
        });
      }
    });
  }

  const auth = getAuth(sandbox);
  authOps.subscribeUsers(auth, () => {
    if (readOnly || !claimsWriterRole) return;
    if (authFlushTimer !== null) clearTimeout(authFlushTimer);
    const scheduledEpoch = authClearEpoch;
    authFlushTimer = setTimeout(() => {
      authFlushTimer = null;
      if (scheduledEpoch !== authClearEpoch) return;
      void runSerialized(async () => {
        if (readOnly || !claimsWriterRole || scheduledEpoch !== authClearEpoch) return;
        try {
          const res = await fetch(section('auth'), {
            method: 'POST',
            headers: buildWriterHeaders(),
            body: JSON.stringify({ users: authOps.exportUsers(auth) }),
          });
          if (isWriterRefusalStatus(res.status)) {
            lostWriterLock();
            return;
          }
          if (res.ok) {
            recordVersionFromResponse(res);
            markWriterGranted();
            diagnostics.lastFlushAt = Date.now();
          }
        } catch (e) {
          console.warn('[pyric sandbox] auth state flush failed:', e);
        }
      });
    }, 500);
  });
}
