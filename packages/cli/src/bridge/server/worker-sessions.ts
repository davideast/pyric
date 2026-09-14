import { randomUUID } from 'node:crypto';
import { FirebaseError } from 'pyric/app';
import { WORKER_SESSION_RETENTION_MS } from '../protocol.js';

interface WorkerSession {
  clientSessionId: string;
  token: string;
  generation: number;
  state: 'attached' | 'interrupted' | 'retired';
  expiry?: ReturnType<typeof setTimeout>;
}

/** A connection's authority over one retained logical worker session. */
export interface WorkerSessionLease {
  clientSessionId: string;
  resumeToken: string;
  isCurrent(): boolean;
  retire(): void;
  detach(): void;
  close(): void;
}

/** Own resume grants and expiry separately from active consumer presence. */
export function createWorkerSessions(callbacks: {
  detach(clientSessionId: string): void;
  close(clientSessionId: string): void;
}) {
  const sessions = new Map<string, WorkerSession>();
  let closed = false;

  function release(session: WorkerSession): void {
    clearTimeout(session.expiry);
    sessions.delete(session.token);
    callbacks.close(session.clientSessionId);
  }

  return {
    attach(resumeToken?: string): WorkerSessionLease {
      if (closed) throw new FirebaseError('unavailable', 'The hosted session owner is closed.');
      let session: WorkerSession;
      const isNewSession = resumeToken === undefined;
      if (isNewSession) {
        session = { clientSessionId: randomUUID(), token: randomUUID(), generation: 0, state: 'attached' };
        sessions.set(session.token, session);
      } else {
        const existing = sessions.get(resumeToken);
        const cannotResume = existing === undefined || existing.state === 'retired';
        if (cannotResume) throw new FirebaseError('unauthenticated', 'The hosted session cannot be resumed.');
        session = existing;
      }
      clearTimeout(session.expiry);
      session.expiry = undefined;
      session.state = 'attached';
      const generation = ++session.generation;
      const isCurrent = (): boolean => sessions.get(session.token) === session && session.generation === generation;
      return {
        clientSessionId: session.clientSessionId,
        resumeToken: session.token,
        isCurrent,
        retire(): void {
          const ownsSession = isCurrent();
          if (ownsSession) session.state = 'retired';
        },
        detach(): void {
          const isStaleConnection = !isCurrent();
          if (isStaleConnection) return;
          const isRetired = session.state === 'retired';
          if (isRetired) {
            release(session);
            return;
          }
          session.state = 'interrupted';
          callbacks.detach(session.clientSessionId);
          session.expiry = setTimeout(() => {
            const ownsSession = isCurrent();
            if (ownsSession) release(session);
          }, WORKER_SESSION_RETENTION_MS);
          session.expiry.unref();
        },
        close(): void {
          const ownsSession = isCurrent();
          if (ownsSession) release(session);
        },
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const session of [...sessions.values()]) release(session);
    },
  };
}
